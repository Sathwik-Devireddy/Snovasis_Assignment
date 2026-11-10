import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient, type RedisLike } from "../../src/infrastructure/redis.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import { appConnectionString, envOrThrow } from "../harness.js";

/**
 * PHASE-05 P5.11/P5.13 — Redis-backed rate limiting (RATE-001/RATE-002).
 *
 * RATE-001: register/login beyond the configured window cap → 429
 * RATE_LIMITED with ZERO durable side effects (no user row, no session).
 * Every pre-cap flood call is refused on its own merits in the SAME limiter
 * bucket — so the cap is reached with NOTHING written at all.
 *
 * RATE-002: disclosed fail-soft — with a dead Redis the limiter fails OPEN
 * and the DB-side countermeasure (T-042 attempt-write volume, Phase 6)
 * remains the second line of defence.
 *
 * Determinism: limiter buckets for the injected peer IP are RESET in
 * beforeAll so files/runs never inherit warm counters from each other.
 */

describe("register/login rate limiting (real Redis; RATE-001/002)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: RedisLike;

  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    // Rate-limiter tests use a dedicated Redis database so parallel test files
    // sharing Redis never contaminate each other's fixed-window buckets.
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/1", lazyConnect: false });
    pgPool = createPgPool({ connectionString: appConnectionString() });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });
    // Deterministic start: nobody inherits this run's warm buckets.
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  }, 40_000);

  beforeEach(async () => {
    // Each test owns a fresh limiter bucket: the limiter runs before
    // validation, so invalid attempts consume the bucket too.
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    await app?.close();
    await redis.quit().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 40_000);

  const registerOnce = (email: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });

  it("register beyond the window cap returns 429 with ZERO durable side effects (RATE-001)", async () => {
    const cfg = loadConfig(process.env);
    const limit = cfg.RATE_LIMIT_REGISTER_LIMIT;
    const floodBase = `rl_reg_${randomBytes(4).toString("hex")}`;

    const usersBefore = await prismaClient().user.count({
      where: { email: { startsWith: floodBase } },
    });

    // Pre-cap floods: each is refused on its own merits (uniform 400 registration
    // failure) but increments the SAME bucket → the cap is reached side-effect-free.
    for (let i = 0; i < limit; i++) {
      const res = await registerOnce(`${floodBase}_f${i}@test.local`, "short");
      expect(res.statusCode).toBe(400);
    }
    // Overflow: a VALID registration that would succeed if allowed → must be 429.
    const overflowEmail = `${floodBase}_overflow@test.local`;
    const limited = await registerOnce(overflowEmail, "a-very-reasonable-password-for-register-tests");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: "RATE_LIMITED", message: "Too many requests. Try again later." });

    // Zero side effects: the valid request created NO row.
    expect(await prismaClient().user.count({ where: { email: overflowEmail } })).toBe(0);
    expect(await prismaClient().user.count({ where: { email: { startsWith: floodBase } } })).toBe(usersBefore);
  });

  it("login floods hit the same 429 envelope; the refusal reveals no account state", async () => {
    const cfg = loadConfig(process.env);
    const limit = cfg.RATE_LIMIT_LOGIN_LIMIT;
    const unknownEmail = `rl_login_${randomBytes(4).toString("hex")}@test.local`;

    for (let i = 0; i < limit; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        headers: { "content-type": "application/json" },
        // Malformed password → same-limiter-bucket refusal, no argon2 burn.
        payload: { email: unknownEmail, password: "no-such-credentials-here-at-all" },
      });
      expect(res.statusCode).toBe(401);
    }
    const over = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: { email: unknownEmail, password: "yet-another-credential-attempt" },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("RATE_LIMITED");
    expect(over.body).not.toContain(unknownEmail);
    expect(over.body.toLowerCase()).not.toContain("redis");
  });

  it("RATE-002 fail-soft: with a dead Redis the limiter fails OPEN (T-060 — Redis is never authoritative)", async () => {
    const cfg = loadConfig(process.env);
    const deadRedis = createRedisClient({ url: "redis://127.0.0.1:9", lazyConnect: true });
    const app2 = buildApp({ config: cfg, pgPool, redis: deadRedis, prisma: prismaClient() });
    try {
      const email = `rl_dead_${randomBytes(4).toString("hex")}@test.local`;
      const res = await app2.inject({
        method: "POST",
        url: "/register",
        headers: { "content-type": "application/json" },
        payload: { email, password: "a-very-reasonable-password-for-register-tests" },
      });
      // No 429, no hang: degradation is disclosed as fail-open; the DB-side
      // attempt-volume cap (T-042, Phase 6) stays the second line of defence.
      expect(res.statusCode).toBe(201);
    } finally {
      await deadRedis.quit().catch(() => undefined);
      await app2.close();
    }
  });
});

export type NoopTypes = Config;
