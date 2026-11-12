import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  ownerConnectionString,
  envOrThrow,
  independentConnection,
  closeIndependent,
} from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * Reconciliation CONSERVATION regression (master-stabilisation B1 / finding 3.1).
 *
 * The old summary computed the clearing balance as
 * `SUM(balance_minor) WHERE kind = 'SYSTEM'` — but SYSTEM cached balances are
 * required to be NULL (P6.2), so the sum was always 0 and any non-zero
 * customer total was falsely reported as a conservation FAILURE. The fix
 * derives BOTH sides from `ledger_entries` (Σcredits − Σdebits).
 *
 * These tests run REAL money operations (deposit, withdrawal, transfer) and
 * assert exact conservation — impossible to satisfy under the old formula —
 * plus the SYSTEM-account per-account reconciliation flag, the corrupted-
 * stored-balance detection, and the DB-level unbalanced-journal rejection.
 */

const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;

let app: FastifyInstance;
let pgPool: Pool;
let redis: ReturnType<typeof createRedisClient>;
let adminEmail = "";
let holderEmail = "";
const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;
let accountA = "";
let accountB = "";
let clearingId = "";
let fixtureSuffix = "";

describe("reconciliation conservation after real money operations (master-stabilisation B1)", () => {
  beforeAll(async () => {
    process.env.RATE_LIMIT_MONEY_LIMIT = "500";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/6", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    fixtureSuffix = randomBytes(5).toString("hex");
    adminEmail = `conserve_admin_${fixtureSuffix}@test.local`;
    holderEmail = `conserve_holder_${fixtureSuffix}@test.local`;
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE')",
        [adminEmail, await hashPassword(adminPassword)],
      );
      await conn.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE')",
        [holderEmail, await hashPassword(holderPassword)],
      );
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
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email = ANY($1)",
        [[adminEmail, holderEmail]],
      );
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

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    return raw.split(";")[0]!.replace(/^bv_session=/, "");
  }

  const adminLogin = () => login(adminEmail, adminPassword);
  const holderLogin = () => login(holderEmail, holderPassword);

  /**
   * The LEDGER-DERIVED position of the shared EXTERNAL_CLEARING account
   * (Σcredits − Σdebits) — the authoritative figure the API must report.
   */
  async function clearingDerived(): Promise<bigint> {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ derived: string }>(
        `SELECT COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor
                                  ELSE -le.amount_minor END), 0)::text AS derived
           FROM ledger_entries le
           JOIN accounts a ON a.id = le.account_id
          WHERE a.account_number = 'EXTERNAL_CLEARING'`,
      );
      return BigInt(rows[0]!.derived);
    } finally {
      await closeIndependent(conn);
    }
  }

  async function holderId(): Promise<string> {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ id: string }>(
        "SELECT id::text AS id FROM users WHERE email = $1",
        [holderEmail],
      );
      return rows[0]!.id;
    } finally {
      await closeIndependent(conn);
    }
  }

  async function createAccount(admin: string, label: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: admin },
      payload: {
        accountNumber: `cons_${randomBytes(5).toString("hex")}`,
        label,
        currencyCode: "INR",
        kind: "CUSTOMER",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().account.id as string;
  }

  it("deposit + withdrawal + transfer → exact conservation from ledger entries", async () => {
    const admin = await adminLogin();
    accountA = await createAccount(admin, "conservation A");
    accountB = await createAccount(admin, "conservation B");

    // Transfers require a TRANSFER grant on the source for EVERY actor
    // (T-025/H-2 guard; admins cannot self-grant — AUTH-004). Grant the
    // holder TRANSFER + VIEW on A, then perform the transfer as the holder.
    await app.inject({
      method: "POST",
      url: "/account-permissions",
      cookies: { bv_session: admin },
      payload: { userId: await holderId(), accountId: accountA, permission: "TRANSFER" },
    });
    const holder = await holderLogin();

    const clearingConn = await independentConnection(appConnectionString());
    try {
      const { rows } = await clearingConn.query<{ id: string }>(
        "SELECT id::text AS id FROM accounts WHERE account_number = 'EXTERNAL_CLEARING'",
      );
      clearingId = rows[0]!.id;
    } finally {
      await closeIndependent(clearingConn);
    }

    // Baseline of the SHARED clearing account (other suites/environments use
    // it too): the assertions below compare the DELTA this fixture causes,
    // never an absolute shared total.
    const baseline = await clearingDerived();

    // Deposit 100000 → A.
    const dep = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: admin },
      headers: { "idempotency-key": `cons_dep_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100000", currencyCode: "INR" },
    });
    expect(dep.statusCode).toBe(200);
    expect(dep.json().status).toBe("SUCCEEDED");

    // Withdraw 30000 from A (admin role-level).
    const wdr = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: admin },
      headers: { "idempotency-key": `cons_wdr_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "30000", currencyCode: "INR" },
    });
    expect(wdr.statusCode).toBe(200);
    expect(wdr.json().status).toBe("SUCCEEDED");

    // Transfer 20000 A → B (holder with the TRANSFER grant on the source).
    const trf = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: holder },
      headers: { "idempotency-key": `cons_trf_${randomBytes(4).toString("hex")}` },
      payload: {
        sourceAccountId: accountA,
        destinationAccountId: accountB,
        amountMinor: "20000",
        currencyCode: "INR",
      },
    });
    expect(trf.statusCode).toBe(200);
    expect(trf.json().status).toBe("SUCCEEDED");

    // Summary: customerTotal + clearing == 0 EXACTLY (the regression: the old
    // code read clearing from NULL cached balances → always 0 → false alarm).
    const summary = await app.inject({
      method: "GET",
      url: "/reconciliation/summary",
      cookies: { bv_session: admin },
    });
    expect(summary.statusCode).toBe(200);
    const conservation = summary.json().conservation;
    expect(conservation.conserved).toBe(true);
    expect(BigInt(conservation.customerBalancesTotal) + BigInt(conservation.clearingBalance)).toBe(
      0n,
    );
    // The clearing side is LEDGER-DERIVED, not the constant "0" the old
    // cached-balance query produced. Asserted as a DELTA against the shared
    // account's baseline: this fixture deposits 100000 (external money in → the
    // clearing account is debited 100000) and withdraws 30000 (credited
    // 30000). The transfer A→B never touches clearing (both legs are
    // customer accounts), so the clearing position moves by exactly −70000.
    expect(BigInt(conservation.clearingBalance)).toBe(baseline - 70_000n);

    // Per-account: A stored == derived == 100000 − 30000 − 20000.
    const a = await app.inject({
      method: "GET",
      url: `/reconciliation/accounts/${accountA}`,
      cookies: { bv_session: admin },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().storedBalance).toBe("50000");
    expect(a.json().derivedBalance).toBe("50000");
    expect(a.json().balanceReconciled).toBe(true);

    // B: 20000.
    const b = await app.inject({
      method: "GET",
      url: `/reconciliation/accounts/${accountB}`,
      cookies: { bv_session: admin },
    });
    expect(b.statusCode).toBe(200);
    expect(b.json().derivedBalance).toBe("20000");
    expect(b.json().balanceReconciled).toBe(true);

    // SYSTEM clearing account: stored cached balance is NULL by design
    // (P6.2); reconciliation must treat the ledger-derived position as the
    // authority and report balanceReconciled TRUE (the old code reported
    // false because NULL ≠ derived).
    const clearing = await app.inject({
      method: "GET",
      url: `/reconciliation/accounts/${clearingId}`,
      cookies: { bv_session: admin },
    });
    expect(clearing.statusCode).toBe(200);
    expect(clearing.json().account.kind).toBe("SYSTEM");
    expect(clearing.json().storedBalance).toBeNull();
    expect(clearing.json().balanceReconciled).toBe(true);
    // The clearing account is SHARED (EXTERNAL_CLEARING) across the whole
    // environment, so its absolute total depends on other activity. The
    // regression that matters: the API must equal the LEDGER-DERIVED position
    // (Σcredits − Σdebits), NOT the constant "0" the old cached-balance query
    // produced (SYSTEM cached balances are NULL → SUM was always 0).
    expect(BigInt(clearing.json().derivedBalance)).toBe(await clearingDerived());
    expect(BigInt(clearing.json().derivedBalance)).toBe(baseline - 70_000n);
  });

  it("corrupted stored balance is detected (per-account + summary)", async () => {
    // Owner role: the runtime role cannot arbitrarily UPDATE accounts.
    const owner = await independentConnection(ownerConnectionString());
    try {
      await owner.query("BEGIN");
      await owner.query("UPDATE accounts SET balance_minor = balance_minor + 7 WHERE id = $1", [
        BigInt(accountA),
      ]);
      await owner.query("COMMIT");
    } finally {
      await closeIndependent(owner);
    }

    try {
      const admin = await adminLogin();
      const a = await app.inject({
        method: "GET",
        url: `/reconciliation/accounts/${accountA}`,
        cookies: { bv_session: admin },
      });
      expect(a.statusCode).toBe(200);
      expect(a.json().storedBalance).toBe("50007");
      expect(a.json().derivedBalance).toBe("50000");
      expect(a.json().balanceReconciled).toBe(false);
      expect(a.json().reconciled).toBe(false);
    } finally {
      // Restore exact state so other suites still see a clean ledger.
      const owner = await independentConnection(ownerConnectionString());
      try {
        await owner.query("BEGIN");
        await owner.query("UPDATE accounts SET balance_minor = balance_minor - 7 WHERE id = $1", [
          BigInt(accountA),
        ]);
        await owner.query("COMMIT");
      } finally {
        await closeIndependent(owner);
      }
    }
  });

  it("unbalanced journal cannot be committed (DB-enforced I1)", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("BEGIN");
      const { rows: journalRows } = await conn.query<{ id: string }>(
        `INSERT INTO journal_transactions (type, status, currency_code, initiated_by)
         VALUES ('ADJUSTMENT', 'POSTED', 'INR', NULL) RETURNING id::text AS id`,
      );
      const journalId = BigInt(journalRows[0]!.id);
      await conn.query(
        `INSERT INTO ledger_entries
           (journal_transaction_id, account_id, direction, amount_minor, currency_code,
            balance_after_minor, account_event_seq)
         VALUES ($1, $2, 'DEBIT', 100, 'INR', NULL, NULL),
                ($1, $2, 'CREDIT', 50, 'INR', NULL, NULL)`,
        [journalId, BigInt(accountA)],
      );
      // Deferred trigger must ABORT the COMMIT.
      await expect(conn.query("COMMIT")).rejects.toThrow(/unbalanced/i);
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
      await closeIndependent(conn);
    }
  });
});
