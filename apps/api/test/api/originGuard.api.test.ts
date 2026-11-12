import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import { appConnectionString, envOrThrow } from "../harness.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * CSRF origin policy at the ROUTE level (master-stabilisation — Stage C).
 *
 * Regression: the frontend reaches the API through the Next.js `/api/*`
 * rewrite, whose internal proxy sets `changeOrigin: true` — the upstream Host
 * header is the API origin while the browser host survives in
 * `x-forwarded-host`. The previous `Origin === Host` comparison rejected every
 * browser mutation with 400 "Request origin not allowed." (login, logout,
 * deposits, withdrawals, transfers, administration were all unusable).
 *
 * These tests drive the REAL routes with the header set the proxy produces.
 */

let app: FastifyInstance;
let pgPool: Pool;
let redis: ReturnType<typeof createRedisClient>;
let previousAppOrigin: string | undefined;

function freshEmail(): string {
  return `origin_${randomBytes(8).toString("hex")}@test.local`;
}

describe("mutation origin policy through the frontend rewrite proxy (Stage C regression)", () => {
  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/4", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });
    previousAppOrigin = process.env.APP_ORIGIN;
  }, 60_000);

  afterAll(async () => {
    if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousAppOrigin;
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient()
      .$disconnect()
      .catch(() => undefined);
  }, 60_000);

  it("accepts a proxied browser registration (Origin=web, Host=api, x-forwarded-host=web)", async () => {
    delete process.env.APP_ORIGIN;
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    const email = freshEmail();
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        host: "localhost:4000",
        "x-forwarded-host": "localhost:3000",
      },
      payload: { email, password: "a-long-reasonable-password-1" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("still refuses a cross-origin browser mutation", async () => {
    delete process.env.APP_ORIGIN;
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "localhost:4000",
        "x-forwarded-host": "localhost:3000",
      },
      payload: { email: freshEmail(), password: "a-long-reasonable-password-2" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("with APP_ORIGIN configured, only allow-listed origins mutate (proxied host is not trusted)", async () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    try {
      await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
      const allowed = await app.inject({
        method: "POST",
        url: "/register",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.com",
          host: "api.internal:4000",
          "x-forwarded-host": "app.internal",
        },
        payload: { email: freshEmail(), password: "a-long-reasonable-password-3" },
      });
      expect(allowed.statusCode).toBe(201);

      await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
      const refused = await app.inject({
        method: "POST",
        url: "/register",
        headers: {
          "content-type": "application/json",
          origin: "https://other.example",
          host: "api.internal:4000",
          // A forged forwarded host must NOT open the door.
          "x-forwarded-host": "other.example",
        },
        payload: { email: freshEmail(), password: "a-long-reasonable-password-4" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("VALIDATION_FAILED");
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });
});
