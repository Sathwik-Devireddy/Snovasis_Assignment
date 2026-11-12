import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import {
  appConnectionString,
  envOrThrow,
  independentConnection,
  closeIndependent,
} from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * INT64 boundary regression (master-stabilisation B7 / finding 5.3), API level.
 *
 * 19-digit ids ABOVE INT64_MAX ("9223372036854775808") previously reached
 * PostgreSQL bigint params and blew up with a driver error (22003) → an
 * accidental 500. Every id boundary site now validates `isInt64Token` first
 * and answers with the SAME uniform envelope as a nonexistent target:
 *   - id in the route path or an actor-scoped lookup → uniform 404
 *     ACCOUNT_NOT_FOUND (no enumeration);
 *   - id inside a request body or pagination cursor → 400 VALIDATION_FAILED.
 *
 * (Transport-shape helpers are unit-tested in int64AndCancellation.test.ts;
 * these tests prove the HTTP behaviour end to end through the routes.)
 */

// One above INT64_MAX.
const OVER_RANGE = "9223372036854775808";
// 20 digits — also above INT64_MAX.
const OVER_RANGE_20 = "99999999999999999999";

const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
let app: FastifyInstance;
let pgPool: Pool;
let redis: ReturnType<typeof createRedisClient>;
let adminCookie = "";
let adminEmail = "";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("INT64 boundary ids answer uniformly, never 500 (master-stabilisation B7)", () => {
  beforeAll(async () => {
    process.env.RATE_LIMIT_MONEY_LIMIT = "500";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/9", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    adminEmail = `boundary_admin_${randomBytes(5).toString("hex")}@test.local`;
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE')",
        [adminEmail, await hashPassword(adminPassword)],
      );
    } finally {
      await closeIndependent(conn);
    }
    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: adminEmail, password: adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    adminCookie = raw.split(";")[0]!.replace(/^bv_session=/, "");
  }, 60_000);

  afterAll(async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("UPDATE users SET status = 'DISABLED' WHERE email = $1", [adminEmail]);
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient()
      .$disconnect()
      .catch(() => undefined);
  }, 60_000);

  it("GET /accounts/:id — 19- and 20-digit over-range ids are uniform 404, not 500", async () => {
    for (const id of [OVER_RANGE, OVER_RANGE_20, "abc"]) {
      const res = await app.inject({
        method: "GET",
        url: `/accounts/${id}`,
        cookies: { bv_session: adminCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("GET /transactions/:id — over-range transaction ids are uniform 404", async () => {
    for (const id of [OVER_RANGE, OVER_RANGE_20]) {
      const res = await app.inject({
        method: "GET",
        url: `/transactions/${id}`,
        cookies: { bv_session: adminCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("GET /accounts/:id/statement — over-range account id is uniform 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/accounts/${OVER_RANGE}/statement`,
      cookies: { bv_session: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("GET /accounts/:id/statement?cursor — over-range id inside the cursor is 400, not 500", async () => {
    const cursor = b64url({ e: OVER_RANGE, a: null });
    const res = await app.inject({
      method: "GET",
      url: "/accounts/1/statement",
      cookies: { bv_session: adminCookie },
      query: { cursor },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("GET /reconciliation/accounts/:id — over-range id is uniform 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/reconciliation/accounts/${OVER_RANGE}`,
      cookies: { bv_session: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("GET /audit/events — over-range actor_id and cursor id are 400, not 500", async () => {
    const byActor = await app.inject({
      method: "GET",
      url: "/audit/events",
      cookies: { bv_session: adminCookie },
      query: { actor_id: OVER_RANGE },
    });
    expect(byActor.statusCode).toBe(400);
    expect(byActor.json().error.code).toBe("VALIDATION_FAILED");

    const byCursor = await app.inject({
      method: "GET",
      url: "/audit/events",
      cookies: { bv_session: adminCookie },
      query: { cursor: b64url({ ts: null, id: OVER_RANGE }) },
    });
    expect(byCursor.statusCode).toBe(400);
    expect(byCursor.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("POST /accounts/:id/deposits — over-range account id is 400 (transport boundary), not 500", async () => {
    await resetLimiterBuckets(redis, "money", "ip:127.0.0.1");
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${OVER_RANGE}/deposits`,
      cookies: { bv_session: adminCookie },
      headers: { "idempotency-key": `b7_dep_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("POST /transfers — over-range account refs in the body are 400, not 500", async () => {
    await resetLimiterBuckets(redis, "money", "ip:127.0.0.1");
    const res = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: adminCookie },
      headers: { "idempotency-key": `b7_trf_${randomBytes(4).toString("hex")}` },
      payload: {
        sourceAccountId: OVER_RANGE,
        destinationAccountId: "1",
        amountMinor: "100",
        currencyCode: "INR",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("PATCH /users/:id/role and POST/DELETE /account-permissions — over-range ids are uniform 404", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/users/${OVER_RANGE}/role`,
      cookies: { bv_session: adminCookie },
      headers: { "content-type": "application/json" },
      payload: { role: "AUDITOR" },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const grant = await app.inject({
      method: "POST",
      url: "/account-permissions",
      cookies: { bv_session: adminCookie },
      headers: { "content-type": "application/json" },
      payload: { userId: OVER_RANGE, accountId: "1", permission: "VIEW" },
    });
    expect(grant.statusCode).toBe(404);
    expect(grant.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const revoke = await app.inject({
      method: "DELETE",
      url: "/account-permissions",
      cookies: { bv_session: adminCookie },
      headers: { "content-type": "application/json" },
      payload: { userId: OVER_RANGE, accountId: "1", permission: "VIEW" },
    });
    expect(revoke.statusCode).toBe(404);
    expect(revoke.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
