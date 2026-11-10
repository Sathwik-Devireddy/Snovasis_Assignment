import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
  revokeSession,
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
        throw new DomainError(UNIFORM_LOGIN_REFUSAL.code, UNIFORM_LOGIN_REFUSAL.message);
      }

      // Verified ACTIVE user → issue a session (opaque token, hashed at rest).
      const rawToken = generateOpaqueToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + deps.sessions.sessionTtlSeconds * 1000);
      const session = await deps.prisma.session.create({
        data: { userId: user.id, tokenHash, expiresAt, userAgentHash },
        select: { id: true },
      });
      await deps.prisma.auditEvent.create({
        data: {
          actorId: user.id,
          eventType: "LOGIN_SUCCEEDED",
          subjectType: "session",
          subjectId: session.id.toString(),
        },
      });
      setSessionCookie(reply, deps.sessions, rawToken);
      return await reply.code(200).send({ user: { id: user.id.toString(), email: user.email, role: user.role } });
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
      await revokeSession(deps.sessions, request.actor);
      await deps.prisma.auditEvent.create({
        data: {
          actorId: BigInt(request.actor.id),
          eventType: "SESSION_REVOKED",
          subjectType: "session",
          subjectId: request.actor.sessionId,
          metadata: { revoked_by: "self" },
        },
      });
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
