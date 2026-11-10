import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { appConnectionString, envOrThrow } from "../harness.js";

/**
 * PHASE-04 P4.4 + P4.4+ — /health liveness and /ready dependency checks,
 * against REAL PostgreSQL + Redis from the environment (no mocks).
 * /ready must fail (503) when a dependency is unreachable, revealing no
 * credentials or environment details.
 */
describe("health & readiness endpoints (real services)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;

  beforeAll(() => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL"), lazyConnect: false });
    app = buildApp({
      config: cfg,
      pgPool,
      redis,
      prisma: null, // routine-path smoke is asserted in prismaBoundary.test.ts
    });
  });

  afterAll(async () => {
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
  });

  it("/health answers 200 {ok:true} with no credential details", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.body.toLowerCase()).not.toContain("password");
    expect(res.body.toLowerCase()).not.toContain("127.0.0.1");
  });

  it("/ready answers 200 with postgres+redis ok when both are up", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { postgres: "ok", redis: "ok" } });
  });

  it("/ready reports 503 with per-component flags and no credential leak when Redis is fake-down", async () => {
    // Independent app where Redis pings fail (dead address) — fail-soft infra.
    const deadRedis = createRedisClient({ url: "redis://127.0.0.1:9", lazyConnect: true });
    const cfg = loadConfig(process.env);
    const app2 = buildApp({ config: cfg, pgPool, redis: deadRedis, prisma: null });
    try {
      const res = await app2.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.checks.redis).toBe("unavailable");
      expect(body.checks.postgres).toBe("ok");
      expect(res.body).not.toContain(appConnectionString());
    } finally {
      await deadRedis.quit().catch(() => undefined);
      await app2.close();
    }
  });

  it("a request id is server-generated (no echo of client-controlled ids)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const reqId = res.headers["x-request-id"] as string | undefined;
    expect(reqId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
  });
});
