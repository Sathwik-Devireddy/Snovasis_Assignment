import { describe, it, expect, afterAll } from "vitest";
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
 * 57014 classification regression (master-stabilisation B5 / finding 5.1).
 *
 * SQLSTATE 57014 ("canceling statement") is retry-safe ONLY for a statement
 * timeout; a genuine user-request cancellation must NOT be misclassified as a
 * retryable 503. Through the sanctioned fault-injection hooks:
 *
 *   BV_TEST_FAULT_INJECT=statement_timeout_once → HTTP 503 LOCK_TIMEOUT
 *     (retry-safe: attempt row FAILED/LOCK_TIMEOUT, key NOT consumed, a client
 *     retry with the SAME key succeeds with exactly one financial effect).
 *
 *   BV_TEST_FAULT_INJECT=cancel_once → HTTP 500 INFRA_FAILURE
 *     (NOT 503: the caller must not be told "retry later" for an operation the
 *     user themselves canceled).
 *
 * Pool max=1 and a FRESH app per test make the once-per-client fault land
 * deterministically on the first money command of each scenario.
 */

const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
let adminEmail = "";
let accountId = "";

afterAll(async () => {
  if (adminEmail !== "") {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("UPDATE users SET status = 'DISABLED' WHERE email = $1", [adminEmail]);
    } finally {
      await closeIndependent(conn);
    }
  }
  await prismaClient()
    .$disconnect()
    .catch(() => undefined);
}, 60_000);

async function buildFreshApp(): Promise<{
  app: FastifyInstance;
  pgPool: Pool;
  redis: ReturnType<typeof createRedisClient>;
  adminCookie: string;
}> {
  const cfg = loadConfig(process.env);
  // max 1 → the fault hook (WeakSet per client) fires exactly once.
  const pgPool = createPgPool({ connectionString: appConnectionString(), max: 1 });
  const redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/8", lazyConnect: false });
  const app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

  // Fixture (idempotent): one ADMIN + one CUSTOMER account.
  if (adminEmail === "") {
    adminEmail = `timeout_admin_${randomBytes(5).toString("hex")}@test.local`;
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE')",
        [adminEmail, await hashPassword(adminPassword)],
      );
    } finally {
      await closeIndependent(conn);
    }
  }
  const login = await app.inject({
    method: "POST",
    url: "/login",
    payload: { email: adminEmail, password: adminPassword },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  const adminCookie = raw.split(";")[0]!.replace(/^bv_session=/, "");

  const created = await app.inject({
    method: "POST",
    url: "/accounts",
    cookies: { bv_session: adminCookie },
    payload: {
      accountNumber: `to_${randomBytes(5).toString("hex")}`,
      label: "timeout classification",
      currencyCode: "INR",
      kind: "CUSTOMER",
    },
  });
  expect(created.statusCode).toBe(201);
  accountId = created.json().account.id as string;

  return { app, pgPool, redis, adminCookie };
}

async function actorId(): Promise<string> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE email = $1",
      [adminEmail],
    );
    return rows[0]!.id;
  } finally {
    await closeIndependent(conn);
  }
}

interface KeyState {
  keys: string;
  credited: string;
}

async function attemptCounts(): Promise<{ lockTimeout: string; infra: string }> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ lockTimeout: string; infra: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM transaction_attempts
           WHERE actor_id = $1 AND status = 'FAILED' AND reason_code = 'LOCK_TIMEOUT') AS "lockTimeout",
         (SELECT COUNT(*)::text FROM transaction_attempts
           WHERE actor_id = $1 AND status = 'FAILED' AND reason_code = 'INFRA_FAILURE') AS infra`,
      [await actorId()],
    );
    return rows[0]!;
  } finally {
    await closeIndependent(conn);
  }
}

async function keyState(key: string): Promise<KeyState> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ keys: string; credited: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS keys,
         (SELECT COALESCE(SUM(amount_minor), 0)::text FROM ledger_entries
           WHERE account_id = $2 AND direction = 'CREDIT'
             AND journal_transaction_id IN
               (SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS credited`,
      [key, accountId],
    );
    return rows[0]!;
  } finally {
    await closeIndependent(conn);
  }
}

describe("57014 classification: statement timeout → 503, user cancel → 500 (master-stabilisation B5)", () => {
  it("statement_timeout_once: 503 LOCK_TIMEOUT, key NOT consumed, same-key retry succeeds", async () => {
    const { app, pgPool, redis, adminCookie } = await buildFreshApp();
    const previousEnv = process.env.BV_TEST_FAULT_INJECT;
    process.env.BV_TEST_FAULT_INJECT = "statement_timeout_once";
    const key = `stto_${randomBytes(4).toString("hex")}`;
    try {
      await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
      await resetLimiterBuckets(redis, "money", `actor:${await actorId()}`);
      const baseline = await attemptCounts();

      const first = await app.inject({
        method: "POST",
        url: `/accounts/${accountId}/deposits`,
        cookies: { bv_session: adminCookie },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "125", currencyCode: "INR" },
      });
      expect(first.statusCode).toBe(503);
      expect(first.json().error.code).toBe("LOCK_TIMEOUT");

      // Rolled back: key NOT consumed, no money moved; the FAILED attempt row
      // is classified LOCK_TIMEOUT (the exact regression — before B5 the 57014
      // family could land here as INFRA_FAILURE/500).
      let state = await keyState(key);
      expect(state.keys).toBe("0");
      expect(state.credited).toBe("0");
      expect(await attemptCounts()).toEqual({
        lockTimeout: String(Number(baseline.lockTimeout) + 1),
        infra: baseline.infra,
      });

      // Client retry with the SAME key: succeeds, exactly one effect.
      const retry = await app.inject({
        method: "POST",
        url: `/accounts/${accountId}/deposits`,
        cookies: { bv_session: adminCookie },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "125", currencyCode: "INR" },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().status).toBe("SUCCEEDED");
      state = await keyState(key);
      expect(state.keys).toBe("1");
      expect(state.credited).toBe("125");
    } finally {
      if (previousEnv === undefined) delete process.env.BV_TEST_FAULT_INJECT;
      else process.env.BV_TEST_FAULT_INJECT = previousEnv;
      await app.close();
      await redis.quit?.().catch(() => undefined);
      await pgPool.end();
    }
  }, 60_000);

  it("cancel_once: 500 INFRA_FAILURE (never a false retry-safe 503), key NOT consumed, retry succeeds", async () => {
    const { app, pgPool, redis, adminCookie } = await buildFreshApp();
    const previousEnv = process.env.BV_TEST_FAULT_INJECT;
    process.env.BV_TEST_FAULT_INJECT = "cancel_once";
    const key = `cncl_${randomBytes(4).toString("hex")}`;
    try {
      await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
      await resetLimiterBuckets(redis, "money", `actor:${await actorId()}`);
      const baseline = await attemptCounts();

      const first = await app.inject({
        method: "POST",
        url: `/accounts/${accountId}/deposits`,
        cookies: { bv_session: adminCookie },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "250", currencyCode: "INR" },
      });
      // THE regression: a user-request cancellation must NOT surface as the
      // retryable 503 LOCK_TIMEOUT envelope.
      expect(first.statusCode).toBe(500);
      expect(first.json().error.code).toBe("INFRA_FAILURE");

      let state = await keyState(key);
      expect(state.keys).toBe("0");
      expect(state.credited).toBe("0");
      // THE regression: a user-request cancellation is classified
      // INFRA_FAILURE — NEVER the retry-safe LOCK_TIMEOUT/503 family.
      expect(await attemptCounts()).toEqual({
        lockTimeout: baseline.lockTimeout,
        infra: String(Number(baseline.infra) + 1),
      });

      const retry = await app.inject({
        method: "POST",
        url: `/accounts/${accountId}/deposits`,
        cookies: { bv_session: adminCookie },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "250", currencyCode: "INR" },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().status).toBe("SUCCEEDED");
      state = await keyState(key);
      expect(state.keys).toBe("1");
      expect(state.credited).toBe("250");
    } finally {
      if (previousEnv === undefined) delete process.env.BV_TEST_FAULT_INJECT;
      else process.env.BV_TEST_FAULT_INJECT = previousEnv;
      await app.close();
      await redis.quit?.().catch(() => undefined);
      await pgPool.end();
    }
  }, 60_000);
});
