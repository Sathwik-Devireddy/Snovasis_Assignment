import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "../infrastructure/prisma.js";
import { DomainError } from "../http/errors.js";
import type { Role } from "../domain/permissions.js";

/**
 * Server-managed sessions (PHASE-05 P5.3/P5.4; ADR-006).
 *
 * - Opaque 256-bit token, issued ONCE, travels only in the HttpOnly cookie —
 *   never stored, never logged, never in URLs.
 * - `sessions.token_hash` holds sha256(token) (unique; replay value absent —
 *   option 3 of ADR-006).
 * - Active-session predicate (single representation): `revoked_at IS NULL AND
 *   expires_at > now()`. There is deliberately NO status column.
 * - The resolved actor is always re-derived from the DATABASE (role included).
 *   Handlers never read role/user ids from request payloads (P5.4/Gate 5).
 * - The money path re-reads the session row FOR SHARE inside its transaction
 *   (Phase 6; AUTHZ_MATRIX §D.3a) — this HTTP-layer check is request gating.
 */

export const SESSION_COOKIE_NAME = "bv_session";
/** 256 bits of CSPRNG output, URL-safe (43 chars). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}
/** sha256 hex of the opaque token — the ONLY representation persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
/** Session-bound UA fingerprint (never the raw UA string). */
export function hashUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent || userAgent.length === 0) return null;
  return createHash("sha256").update(userAgent, "utf8").digest("hex").slice(0, 32);
}

export type Actor = {
  id: string;
  role: Role;
  status: "ACTIVE" | "DISABLED";
  sessionId: string;
  /** sha256 of the cookie token; lives ONLY in memory of the request. */
  tokenHash: string;
};

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export type SessionDeps = { prisma: PrismaClient; sessionTtlSeconds: number; cookieSecure: boolean };

export function setSessionCookie(reply: FastifyReply, deps: SessionDeps, rawToken: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    // P5.3/AUTH-006 contract: HttpOnly; Secure; SameSite=Lax. Secure is
    // unconditional in production (config refuses to boot with false there);
    // plain-http localhost dev is the documented ADR-006 exemption.
    secure: deps.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: deps.sessionTtlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, deps: SessionDeps): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
}

/**
 * The auth preHandler (P5.4): every protected route resolves its actor from
 * the database; missing/expired/revoked session or a disabled user is the
 * single `401 UNAUTHENTICATED` refusal. Nothing about the actor is trusted
 * from the client.
 */
export function buildAuthenticate(deps: SessionDeps) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken) {
      throw new DomainError("UNAUTHENTICATED", "Authentication required.");
    }
    const tokenHash = hashToken(rawToken);
    const session = await deps.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    const now = new Date();
    if (!session || session.revokedAt !== null || session.expiresAt <= now) {
      throw new DomainError("UNAUTHENTICATED", "Authentication required.");
    }
    if (session.user.status !== "ACTIVE") {
      throw new DomainError("UNAUTHENTICATED", "Authentication required.");
    }
    request.actor = {
      id: session.user.id.toString(),
      role: session.user.role as Role,
      status: session.user.status as Actor["status"],
      sessionId: session.id.toString(),
      tokenHash,
    };
  };
}

/**
 * Revocation (logout/admin paths): exactly `UPDATE sessions SET revoked_at`
 * per ADR-006 item 2 — never a DELETE. Idempotent by effect (predicate).
 *
 * The logout route performs this update INSIDE its own transaction so the
 * revocation and its SESSION_REVOKED audit event commit together
 * (master-stabilisation 4.2). There is deliberately no standalone helper that
 * revokes a session without its audit event.
 */

