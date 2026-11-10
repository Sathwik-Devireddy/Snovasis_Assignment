import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../http/errors.js";
import type { RedisLike } from "./redis.js";

/**
 * Redis-backed rate limiting (PHASE-05 P5.11; RATE-001/RATE-002, T-060).
 *
 * FIXED-WINDOW counter: one INCR (+ first-hit EXPIRE) per request against a
 * per-scope bucket key. Redis NEVER holds financial/audit/authority state —
 * an outage can only degrade limiting, so the limiter FAILS SOFT (allow +
 * warn) per T-060; the DB-side cap (T-042) stays the second line of defence
 * where it exists (Phase 6 attempt-write volume).
 *
 * Identity: pre-auth endpoints key on the peer IP (`trustProxy: false`, so
 * request.ip is the direct socket peer); authenticated money endpoints
 * (Phase 6) key on the resolved actor id. A refused (429) call has NO side
 * effect on application durable state by construction — the limiter runs
 * before any handler logic.
 */

export type LimiterScope = "register" | "login" | "money";

export type LimiterConfig = { limit: number; windowSeconds: number };

export type RateLimitDeps = {
  redis: RedisLike;
  register: LimiterConfig;
  login: LimiterConfig;
  money: LimiterConfig;
};

/** Stable per-identity bucket key; identities are hashed (keys never carry raw PII). */
function bucketKey(scope: LimiterScope, identity: string, windowSeconds: number): { key: string; ttl: number } {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSeconds);
  const hashedIdentity = createHash("sha256").update(`${scope}:${identity}`).digest("hex").slice(0, 24);
  return { key: `rl:${scope}:${bucket}:${hashedIdentity}`, ttl: windowSeconds };
}

function identityFor(scope: LimiterScope, request: FastifyRequest): string {
  if (scope === "money") {
    const actorId = (request as FastifyRequest & { actor?: { id: string | bigint } }).actor?.id;
    if (actorId !== undefined) return `actor:${actorId}`;
  }
  return `ip:${request.ip}`;
}

/** Throws DomainError("RATE_LIMITED") when over the cap; fail-soft otherwise. */
async function enforceOnce(
  redis: RedisLike,
  request: FastifyRequest,
  scope: LimiterScope,
  cfg: LimiterConfig,
): Promise<void> {
  const { key, ttl } = bucketKey(scope, identityFor(scope, request), cfg.windowSeconds);
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, ttl);
    }
    if (count > cfg.limit) {
      throw new DomainError("RATE_LIMITED", "Too many requests. Try again later.");
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // T-060 fail-soft: limiter degradation never blocks the request.
    request.log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "rate limiter degraded (Redis unavailable) — failing open (DB-side cap remains authoritative)",
    );
  }
}

/**
 * Fastify preHandler factory. Order with the auth plugin for the `money`
 * scope: authenticate (sets request.actor) runs BEFORE rateLimiter so the
 * actor-keyed identity exists.
 */
export function rateLimiter(scope: LimiterScope, deps: RateLimitDeps) {
  const cfg = deps[scope];
  return async function enforce(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    await enforceOnce(deps.redis, request, scope, cfg);
  };
}

export function buildRateLimitDepsFromEnv(
  env: {
    RATE_LIMIT_REGISTER_LIMIT: number;
    RATE_LIMIT_REGISTER_WINDOW_SECONDS: number;
    RATE_LIMIT_LOGIN_LIMIT: number;
    RATE_LIMIT_LOGIN_WINDOW_SECONDS: number;
    RATE_LIMIT_MONEY_LIMIT: number;
    RATE_LIMIT_MONEY_WINDOW_SECONDS: number;
  },
  redis: RedisLike,
): RateLimitDeps {
  return {
    redis,
    register: { limit: env.RATE_LIMIT_REGISTER_LIMIT, windowSeconds: env.RATE_LIMIT_REGISTER_WINDOW_SECONDS },
    login: { limit: env.RATE_LIMIT_LOGIN_LIMIT, windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS },
    money: { limit: env.RATE_LIMIT_MONEY_LIMIT, windowSeconds: env.RATE_LIMIT_MONEY_WINDOW_SECONDS },
  };
}

/**
 * Deterministic limiter-state reset (tests + hygiene only — never called from
 * request paths): deletes every fixed-window bucket for a scope+identity so
 * test files do not inherit warm counters from previous runs.
 */
export async function resetLimiterBuckets(redis: RedisLike, scope: LimiterScope, identity: string): Promise<number> {
  const hashedIdentity = createHash("sha256").update(`${scope}:${identity}`).digest("hex").slice(0, 24);
  const keys = await redis.keys(`rl:${scope}:*:${hashedIdentity}`);
  if (keys.length === 0) return 0;
  return await redis.del(...keys);
}
