import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/index.js";
import type { PrismaClient } from "../../infrastructure/prisma.js";
import { DomainError } from "../errors.js";
import { verifyPassword } from "../../infrastructure/argon2.js";
import { rateLimiter, type RateLimitDeps } from "../../infrastructure/rateLimiter.js";
import {
  buildAuthenticate,
  clearSessionCookie,
  generateOpaqueToken,
  hashToken,
  hashUserAgent,
  setSessionCookie,
  type SessionDeps,
} from "../../auth/session.js";
import { assertMutationHeaders } from "../guards.js";

/**
 * POST /login · POST /logout (PHASE-05 P5.3/P5.4; ADR-006; AUTH-005/AUTH-006).
 *
 * - argon2id verification; unknown user · wrong password · DISABLED status
 *   all return the IDENTICAL 401 envelope (no account enumeration — AUTH-005).
 * - On success: one opaque 256-bit token → cookie (HttpOnly; Secure; SameSite=Lax)
 *   its sha256 hash rows in `sessions`; the raw token is never stored/logged.
 * - Logout revokes the session row (`revoked_at`) — full revocation, cookie
 *   cleared (AUTH-006). Subsequent calls are 401.
 */

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict();

const UNIFORM_LOGIN_REFUSAL = { code: "UNAUTHENTICATED" as const, message: "Invalid email or password." };

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; sessions: SessionDeps; rateLimits: RateLimitDeps },
): void {
  const authenticate = buildAuthenticate(deps.sessions);

  app.post(
    "/login",
    {
      // MUTATION GUARDS first (P5.6); IP-keyed login limiter (T-041 flood
      // family) before ANY handler logic.
      preHandler: [assertMutationHeaders, rateLimiter("login", deps.rateLimits)],
    },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) {
        // Uniform refusal: malformed login attempts are indistinguishable
        // from failed credentials (same envelope, same audit shape).
        throw new DomainError(UNIFORM_LOGIN_REFUSAL.code, UNIFORM_LOGIN_REFUSAL.message);
      }
      const { email, password } = parsed.data;
      const normalizedEmail = email.toLowerCase();
      const userAgentHash = hashUserAgent(
        Array.isArray(request.headers["user-agent"]) ? request.headers["user-agent"][0] : request.headers["user-agent"],
      );

      const user = await deps.prisma.user.findUnique({ where: { email: normalizedEmail } });

      const verified =
        user?.status === "ACTIVE"
          ? await verifyPassword(user.passwordHash, password)
          : // Unknown user (or disabled): still pay a comparable argon2 cost
            // against a DUMMY hash — defeats the "known-but-bad password vs
            // no-account" timing oracle (enumeration resistance, AUTH-005).
            await verifyPassword(DUMMY_HASH, password);

      if (!user || !verified) {
        // Audit-only path (no state change): best-effort insert, exactly like
        // the D-9 money-path refusals — an audit failure never degrades the
        // uniform 401 envelope the caller must receive (AUTH-005).
        try {
          await deps.prisma.auditEvent.create({
            data: {
              actorId: user?.id ?? null,
              eventType: "LOGIN_FAILED",
              subjectType: "user",
              subjectId: user?.id.toString() ?? normalizedEmail,
              // Open internal vocabulary; the external envelope is uniform.
              reasonCode: user ? "BAD_CREDENTIALS" : "NO_USER",
              metadata: { internal_reason: !user ? "unknown_email" : user.status === "DISABLED" ? "account_disabled" : "bad_password" },
            },
          });
        } catch (error) {
          request.log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "LOGIN_FAILED audit row could not be persisted",
          );
        }
        throw new DomainError(UNIFORM_LOGIN_REFUSAL.code, UNIFORM_LOGIN_REFUSAL.message);
      }

      // Verified ACTIVE user → issue a session (opaque token, hashed at rest).
      // Session row + LOGIN_SUCCEEDED audit event commit together or roll
      // back together (master-stabilisation 4.2): no session without its
      // audit record, no audit record for a session that never existed.
      const rawToken = generateOpaqueToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + deps.sessions.sessionTtlSeconds * 1000);
      await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.session.create({
          data: { userId: user.id, tokenHash, expiresAt, userAgentHash },
          select: { id: true },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            eventType: "LOGIN_SUCCEEDED",
            subjectType: "session",
            subjectId: created.id.toString(),
          },
        });
        return created;
      });
      setSessionCookie(reply, deps.sessions, rawToken);
      return await reply.code(200).send({ user: { id: user.id.toString(), email: user.email, role: user.role } });
    },
  );

  /**
   * GET /me — the authenticated-user identity surface (PHASE-05 P5.4
   * contract; requested explicitly by the product's auth checklist).
   *
   * The SAME `authenticate` preHandler as every protected route: a missing,
   * expired or revoked cookie and a disabled user are all the single
   * `401 UNAUTHENTICATED` refusal, resolved from the database — nothing is
   * trusted from the client. The response carries id/email/role only: never
   * the raw token, its hash, the session id, or any credential material.
   */
  app.get(
    "/me",
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required.");
      const user = await deps.prisma.user.findUnique({
        where: { id: BigInt(request.actor.id) },
        select: { id: true, email: true, role: true },
      });
      // The actor was resolved ACTIVE moments ago; a user deleted between the
      // two reads (or disabled) is refused exactly like any other session.
      if (!user) throw new DomainError("UNAUTHENTICATED", "Authentication required.");
      return await reply.code(200).send({
        user: { id: user.id.toString(), email: user.email, role: user.role },
      });
    },
  );

  app.post(
    "/logout",
    {
      // P5.6 mutation guards + the auth plugin resolve the actor first.
      preHandler: [assertMutationHeaders, authenticate],
    },
    async (request, reply) => {
      if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required.");
      // Revocation + SESSION_REVOKED audit commit together or roll back
      // together (master-stabilisation 4.2): an audit failure must not leave
      // a revoked session without its audit record (the caller then receives
      // 500 and may retry — revocation is idempotent by effect).
      await deps.prisma.$transaction([
        deps.prisma.session.update({
          where: { tokenHash: request.actor.tokenHash },
          data: { revokedAt: new Date() },
        }),
        deps.prisma.auditEvent.create({
          data: {
            actorId: BigInt(request.actor.id),
            eventType: "SESSION_REVOKED",
            subjectType: "session",
            subjectId: request.actor.sessionId,
            metadata: { revoked_by: "self" },
          },
        }),
      ]);
      clearSessionCookie(reply, deps.sessions);
      return await reply.code(200).send({ ok: true });
    },
  );
}

// A REAL, never-matching encoded argon2id hash (generated once out-of-band).
// Verifying any candidate against it equalises the cost curve for unknown
// identities; a live `verifyPassword` call on a malformed constant would
// THROW — so only a syntactically valid hash may live here.
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$vO+0KUBxfgKcFNEUho+wAg$OhL1cEJtQl/Kfy3U52VrrQmJiaocragmn2aE7nx0TrQ";
