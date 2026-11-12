import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import { appConnectionString, envOrThrow, independentConnection, closeIndependent } from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * PHASE-10 P10.4 reconciliation on real PostgreSQL + Redis:
 *
 * - Access: ADMIN/AUDITOR → 200; holder/stranger → uniform 404;
 *   unauthenticated → 401.
 * - GET /reconciliation/accounts/:id: stored balance vs ledger-derived,
 *   reconciled flag, balance + sequence reconciliation.
 * - GET /reconciliation/summary: healthy flag, accountsChecked,
 *   journalsChecked, violations, conservation (customer + clearing = 0).
 * - Read-only: INV-001 still holds after the suite.
 * - Money values as strings (T-049).
 */

type Fixture = { suffix: string };

let fixture!: Fixture;

describe("reconciliation (real services; PHASE-10 P10.4)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const auditorPassword = `auditor-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const strangerPassword = `stranger-pw-${randomBytes(8).toString("hex")}-0123456789`;
  let testAccountId = "";

  beforeAll(async () => {
    process.env.RATE_LIMIT_MONEY_LIMIT = "500";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/5", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const suffix = randomBytes(5).toString("hex");
    fixture = { suffix };
    const conn = await independentConnection(appConnectionString());
    try {
      const insert = async (email: string, password: string, role: string): Promise<bigint> => {
        const { rows } = await conn.query<{ id: string }>(
          "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id::text AS id",
          [email, await hashPassword(password), role],
        );
        return BigInt(rows[0]!.id);
      };
      await insert(`admin_${suffix}@test.local`, adminPassword, "ADMIN");
      await insert(`auditor_${suffix}@test.local`, auditorPassword, "AUDITOR");
      await insert(`holder_${suffix}@test.local`, holderPassword, "ACCOUNT_HOLDER");
      await insert(`stranger_${suffix}@test.local`, strangerPassword, "ACCOUNT_HOLDER");
      const recAdminId = await insert(`rec_admin_${suffix}@test.local`, adminPassword, "ADMIN");

      // Create a test account with a balance for reconciliation.
      // event_last_seq = 1 with one allocated event (seq=1) keeps INV-001 clean.
      const { rows } = await conn.query<{ id: string }>(
        `INSERT INTO accounts (account_number, label, currency_code, kind, status, balance_minor, event_last_seq)
         VALUES ($1, $2, 'INR', 'CUSTOMER', 'ACTIVE', 10000, 1) RETURNING id::text AS id`,
        [`rec_${suffix}`, "reconciliation test"],
      );
      testAccountId = rows[0]!.id;

      // Get the external clearing account (seeded by migration 0004).
      const { rows: clearingRows } = await conn.query<{ id: string }>(
        "SELECT id FROM accounts WHERE account_number = 'EXTERNAL_CLEARING'",
      );
      const clearingId = BigInt(clearingRows[0]!.id);

      // Post a balanced journal: DEBIT clearing, CREDIT test account.
      // Stored balance (10000) == ledger-derived (10000 credit).
      await conn.query("BEGIN");
      const { rows: journalRows } = await conn.query<{ id: string }>(
        `INSERT INTO journal_transactions (type, status, currency_code, initiated_by)
         VALUES ('DEPOSIT', 'POSTED', 'INR', $1) RETURNING id::text AS id`,
        [recAdminId],
      );
      const journalId = BigInt(journalRows[0]!.id);
      await conn.query(
        `INSERT INTO ledger_entries
           (journal_transaction_id, account_id, direction, amount_minor,
            currency_code, balance_after_minor, account_event_seq)
         VALUES ($1, $2, 'DEBIT', 10000, 'INR', NULL, NULL),
                ($1, $3, 'CREDIT', 10000, 'INR', 10000, 1)`,
        [journalId, clearingId, BigInt(testAccountId)],
      );
      await conn.query("COMMIT");
    } finally {
      await closeIndependent(conn);
    }
  }, 60_000);

  beforeEach(async () => {
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1",
        [`%_${fixture.suffix}@test.local`],
      );
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 60_000);

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const setCookieHeader = res.headers["set-cookie"];
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(raw).toBeDefined();
    return raw!.split(";")[0]!;
  }

  const adminCookie = () => login(`admin_${fixture.suffix}@test.local`, adminPassword);
  const auditorCookie = () => login(`auditor_${fixture.suffix}@test.local`, auditorPassword);
  const holderCookie = () => login(`holder_${fixture.suffix}@test.local`, holderPassword);
  const strangerCookie = () => login(`stranger_${fixture.suffix}@test.local`, strangerPassword);

  const cookieValue = (setCookie: string): string => setCookie.replace(/^bv_session=/, "").split(";")[0]!;

  async function getPerAccount(
    cookie: string | null,
    accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ statusCode: number; body: any }> {
    const res = await app.inject({
      method: "GET",
      url: `/reconciliation/accounts/${accountId}`,
      ...(cookie ? { cookies: { bv_session: cookieValue(cookie) } } : {}),
    });
    const body = res.json();
    return { statusCode: res.statusCode, body };
  }

  async function getSummary(
    cookie: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ statusCode: number; body: any }> {
    const res = await app.inject({
      method: "GET",
      url: "/reconciliation/summary",
      ...(cookie ? { cookies: { bv_session: cookieValue(cookie) } } : {}),
    });
    const body = res.json();
    return { statusCode: res.statusCode, body };
  }

  it("access: admin/auditor → 200; holder/stranger → uniform 404; unauthenticated → 401", async () => {
    const admin = await adminCookie();
    const auditor = await auditorCookie();
    const holder = await holderCookie();
    const stranger = await strangerCookie();

    const adminRes = await getPerAccount(admin, testAccountId);
    expect(adminRes.statusCode).toBe(200);

    const auditorRes = await getPerAccount(auditor, testAccountId);
    expect(auditorRes.statusCode).toBe(200);

    const holderRes = await getPerAccount(holder, testAccountId);
    expect(holderRes.statusCode).toBe(404);
    expect(holderRes.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const strangerRes = await getPerAccount(stranger, testAccountId);
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const anon = await getPerAccount(null, testAccountId);
    expect(anon.statusCode).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHENTICATED");

    // Non-numeric id → uniform 404.
    const weird = await getPerAccount(admin, "not-a-number");
    expect(weird.statusCode).toBe(404);
    expect(weird.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    // Nonexistent account → uniform 404.
    const missing = await getPerAccount(admin, "999999");
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("per-account reconciliation: stored vs ledger-derived balance", async () => {
    const admin = await adminCookie();
    const res = await getPerAccount(admin, testAccountId);
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body.account.id).toBe(testAccountId);
    expect(body.account.kind).toBe("CUSTOMER");
    expect(body.account.status).toBe("ACTIVE");
    // Money as strings (T-049).
    expect(typeof body.storedBalance).toBe("string");
    expect(typeof body.derivedBalance).toBe("string");
    expect(body.storedBalance).toBe("10000");
    expect(body.derivedBalance).toBe("10000");
    expect(body.balanceReconciled).toBe(true);
    expect(body.reconciled).toBe(true);
    expect(typeof body.entriesCount).toBe("number");
    expect(body.entriesCount).toBeGreaterThanOrEqual(1);
    expect(typeof body.journalCount).toBe("number");
    expect(body.journalCount).toBeGreaterThanOrEqual(1);
  });

  it("global summary: healthy, violations, conservation", async () => {
    const admin = await adminCookie();
    const res = await getSummary(admin);
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(typeof body.healthy).toBe("boolean");
    expect(typeof body.accountsChecked).toBe("number");
    expect(typeof body.journalsChecked).toBe("number");
    expect(Array.isArray(body.violations)).toBe(true);
    expect(body.accountsChecked).toBeGreaterThan(0);
    expect(body.journalsChecked).toBeGreaterThan(0);

    // Conservation fields.
    expect(typeof body.conservation.customerBalancesTotal).toBe("string");
    expect(typeof body.conservation.clearingBalance).toBe("string");
    expect(typeof body.conservation.conserved).toBe("boolean");
  });

  it("auditor can view reconciliation (read-only role)", async () => {
    const auditor = await auditorCookie();
    const res = await getPerAccount(auditor, testAccountId);
    expect(res.statusCode).toBe(200);
    expect(res.body.reconciled).toBe(true);

    const summary = await getSummary(auditor);
    expect(summary.statusCode).toBe(200);
    expect(typeof summary.body.healthy).toBe("boolean");
  });
});
