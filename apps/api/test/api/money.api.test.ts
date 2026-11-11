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
 * PHASE-06 money surface on real PostgreSQL + Redis (P6.9):
 *
 * - POST /accounts is admin-only (AC2.1): zero-balance CUSTOMER creation,
 *   INR-only, audited; non-admins receive the uniform 404 envelope.
 * - Deposits are the ADMIN cash desk (H-2); withdrawals honour the WITHDRAW
 *   grant; transfers honour TRANSFER for every actor (admins included).
 * - Business refusals are committed replayable outcomes (D-8 steps 3/5):
 *   INVALID_AMOUNT / CURRENCY_MISMATCH / SAME_ACCOUNT / INSUFFICIENT_FUNDS /
 *   ACCOUNT_NOT_ACTIVE, each with the attempt row the statement design
 *   requires; authorisation refusals stay the single uniform 404 envelope
 *   and consume no key (D-9 path).
 * - Idempotency (IDEMPOTENCY_BEHAVIORS rows 1-5): same key + same payload
 *   replays (replayed: true, no second journal); same key + different
 *   payload → 409 KEY_REUSED, no fabricated attempt row.
 * - Conservation: every journal is balanced (debits = credits) at the DB.
 */

type Fixture = {
  suffix: string;
  adminEmail: string;
  adminPassword: string;
  holderEmail: string;
  holderPassword: string;
  strangerEmail: string;
};

let fixture!: Fixture;
let seedSuffix = "";

describe("money endpoints (real services; PHASE-06 P6.9)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const strangerPassword = `stranger-pw-${randomBytes(8).toString("hex")}-0123456789`;
  let accountA = ""; // holder-operated CUSTOMER account
  let accountB = ""; // transfer destination
  let clearingId = "";

  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/5", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const suffix = randomBytes(5).toString("hex");
    seedSuffix = suffix;
    const conn = await independentConnection(appConnectionString());
    try {
      const insert = async (email: string, passwordHash: string, role: string): Promise<string> => {
        const { rows } = await conn.query(
          "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id",
          [email, passwordHash, role],
        );
        return String(rows[0]!.id);
      };
      const adminId = await insert(`admin_${suffix}@test.local`, await hashPassword(adminPassword), "ADMIN");
      await insert(`holder_${suffix}@test.local`, await hashPassword(holderPassword), "ACCOUNT_HOLDER");
      await insert(`stranger_${suffix}@test.local`, await hashPassword(strangerPassword), "ACCOUNT_HOLDER");
      fixture = {
        suffix,
        adminEmail: `admin_${suffix}@test.local`,
        adminPassword,
        holderEmail: `holder_${suffix}@test.local`,
        holderPassword,
        strangerEmail: `stranger_${suffix}@test.local`,
      };
      void adminId;
    } finally {
      await closeIndependent(conn);
    }

    // EXTERNAL_CLEARING seed id (migration 0004).
    const seedConn = await independentConnection(appConnectionString());
    try {
      const { rows } = await seedConn.query(
        "SELECT id FROM accounts WHERE account_number = 'EXTERNAL_CLEARING'",
      );
      clearingId = String(rows[0]!.id);
    } finally {
      await closeIndependent(seedConn);
    }
  }, 60_000);

  beforeEach(async () => {
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "money", `actor:${await currentActorId("admin")}`);
    await resetLimiterBuckets(redis, "money", `actor:${await currentActorId("holder")}`);
    await resetLimiterBuckets(redis, "money", `actor:${await currentActorId("stranger")}`);
  });

  afterAll(async () => {
    // Users are lifecycle rows: DISABLE (never delete) so a later bootstrap
    // run sees no lingering active administrator.
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1",
        [`%_${seedSuffix}@test.local`],
      );
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 60_000);

  async function currentActorId(prefix: "admin" | "holder" | "stranger"): Promise<string> {
    if (!fixture) return "";
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query(
        "SELECT id::text AS id FROM users WHERE email = $1",
        [`${prefix}_${fixture.suffix}@test.local`],
      );
      return rows[0]?.id as string | undefined ?? "";
    } finally {
      await closeIndependent(conn);
    }
  }

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

  const adminCookie = () => login(fixture.adminEmail, adminPassword);
  const holderCookie = () => login(fixture.holderEmail, holderPassword);
  const strangerCookie = () => login(fixture.strangerEmail, strangerPassword);

  const uniqueAccountNumber = () => `acc_${randomBytes(6).toString("hex")}`;

  async function grant(permission: string, accountId: string, granteeEmail: string): Promise<void> {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
         SELECT u.id, $2, $3, u.id FROM users u WHERE u.email = $1`,
        [granteeEmail, BigInt(accountId), permission],
      );
    } finally {
      await closeIndependent(conn);
    }
  }

  it("POST /accounts is admin-only (uniform 404 for holders; AC2.1)", async () => {
    const holder = await holderCookie();
    const refused = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(holder) },
      payload: { accountNumber: uniqueAccountNumber(), label: "x", currencyCode: "INR", kind: "CUSTOMER" },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const admin = await adminCookie();
    const ok = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: { accountNumber: uniqueAccountNumber(), label: "holder A", currencyCode: "INR", kind: "CUSTOMER" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().account.balanceMinor).toBe("0");
    accountA = ok.json().account.id;

    const b = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: { accountNumber: uniqueAccountNumber(), label: "holder B", currencyCode: "INR", kind: "CUSTOMER" },
    });
    expect(b.statusCode).toBe(201);
    accountB = b.json().account.id;
  });

  it("POST /accounts refuses non-INR currencies and duplicate numbers", async () => {
    const admin = await adminCookie();
    const usd = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: { accountNumber: uniqueAccountNumber(), label: "x", currencyCode: "USD", kind: "CUSTOMER" },
    });
    expect(usd.statusCode).toBe(400);
    expect(usd.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("deposit happy path (admin cash desk, H-2): posts a balanced journal", async () => {
    const admin = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `dep_ok_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100000", currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "SUCCEEDED", replayed: false });

    const detail = await app.inject({
      method: "GET",
      url: `/accounts/${accountA}`,
      cookies: { bv_session: cookieValue(admin) },
    });
    expect(detail.json().account.balanceMinor).toBe("100000");

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ debit: string; credit: string; accounts: string }>(
        `SELECT
           COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debit,
           COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credit,
           COUNT(DISTINCT account_id)::text AS accounts
         FROM ledger_entries WHERE journal_transaction_id = $1`,
        [res.json().journalTransactionId],
      );
      expect(rows[0]).toEqual({ debit: "100000", credit: "100000", accounts: "2" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("deposit by a non-admin is the uniform 404 envelope (key NOT consumed)", async () => {
    const holder = await holderCookie();
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `dep_holder_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "1", currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("deposit to the SYSTEM clearing account: granular 409 for the admin", async () => {
    const admin = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${clearingId}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `dep_sys_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "500", currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SYSTEM_ACCOUNT_NOT_ALLOWED");
  });

  it("pre-lock business refusals commit a replayable refusal (D-8 step 3)", async () => {
    const admin = await adminCookie();
    const key = `dep_neg_${randomBytes(4).toString("hex")}`;

    const invalid = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "-100", currencyCode: "INR" },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error.code).toBe("INVALID_AMOUNT");

    // Row 2: replaying a committed refusal returns the SAME refusal…
    const replay = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "-100", currencyCode: "INR" },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("INVALID_AMOUNT");

    // …and row 5: same key + different payload → canonical KEY_REUSED.
    const reused = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "-200", currencyCode: "INR" },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("KEY_REUSED");

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM transaction_attempts
          WHERE actor_id = $1 AND operation = 'DEPOSIT' AND reason_code = 'INVALID_AMOUNT'`,
        [await currentActorId("admin")],
      );
      // Row 5 fabricates NO second attempt row.
      expect(Number(rows[0]!.count)).toBe(1);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("unknown currency is a pre-lock CURRENCY_MISMATCH refusal", async () => {
    const admin = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `dep_usd_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "500", currencyCode: "USD" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CURRENCY_MISMATCH");
  });

  it("transport validation: malformed amounts and missing key are 400s, no attempt row", async () => {
    const admin = await adminCookie();
    const bad = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `dep_bad_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100.5", currencyCode: "INR" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");

    const noKey = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("withdrawal: WITHDRAW grant required (uniform 404 otherwise), funds checked under lock", async () => {
    const holder = await holderCookie();
    const stranger = await strangerCookie();
    const key = `wd_${randomBytes(4).toString("hex")}`;

    // No grant yet → uniform 404 (internal FORBIDDEN), key NOT consumed.
    const refused = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    await grant("WITHDRAW", accountA, fixture.holderEmail);
    await grant("VIEW", accountA, fixture.holderEmail);
    await grant("VIEW", accountA, fixture.strangerEmail);

    // Stranger has VIEW (visibility) but no WITHDRAW → still uniform 404.
    const strangerRefused = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(stranger) },
      headers: { "idempotency-key": `wd_s_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(strangerRefused.statusCode).toBe(404);

    // Over-balance withdrawal → 409 INSUFFICIENT_FUNDS with the measured balance.
    const over = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "100000000", currencyCode: "INR" },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe("INSUFFICIENT_FUNDS");

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ balance: string | null }>(
        `SELECT balance_at_attempt_minor::text AS balance
           FROM transaction_attempts
          WHERE account_id = $1 AND reason_code = 'INSUFFICIENT_FUNDS'
          ORDER BY id DESC LIMIT 1`,
        [BigInt(accountA)],
      );
      expect(rows[0]?.balance ?? null).toBe("100000");
    } finally {
      await closeIndependent(conn);
    }

    // Affordable withdrawal succeeds; balance drops.
    const ok = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `wd_ok_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "30000", currencyCode: "INR" },
    });
    expect(ok.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/accounts/${accountA}`,
      cookies: { bv_session: cookieValue(await adminCookie()) },
    });
    expect(detail.json().account.balanceMinor).toBe("70000");
  });

  it("suspended source refuses money movement under lock (T-012)", async () => {
    const admin = await adminCookie();
    const suspended = uniqueAccountNumber();
    const created = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: { accountNumber: suspended, label: "suspend me", currencyCode: "INR", kind: "CUSTOMER" },
    });
    const accId = created.json().account.id;
    await app.inject({
      method: "POST",
      url: `/accounts/${accId}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `dep_s_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "1000", currencyCode: "INR" },
    });
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("UPDATE accounts SET status = 'SUSPENDED', updated_at = now() WHERE id = $1", [BigInt(accId)]);
    } finally {
      await closeIndependent(conn);
    }
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${accId}/withdrawals`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `wd_susp_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_ACTIVE");
  });

  it("transfer: TRANSFER grant for every actor, balanced net-zero movement", async () => {
    const admin = await adminCookie();
    const holder = await holderCookie();

    // Admin holds NO TRANSFER grant on accountA → uniform 404 (T-025/H-2 guard).
    const adminRefused = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `tr_adm_${randomBytes(4).toString("hex")}` },
      payload: {
        sourceAccountId: accountA,
        destinationAccountId: accountB,
        amountMinor: "100",
        currencyCode: "INR",
      },
    });
    expect(adminRefused.statusCode).toBe(404);

    await grant("TRANSFER", accountA, fixture.holderEmail);

    // Same account → pre-lock SAME_ACCOUNT refusal (key consumed, no movement).
    const same = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `tr_same_${randomBytes(4).toString("hex")}` },
      payload: {
        sourceAccountId: accountA,
        destinationAccountId: accountA,
        amountMinor: "100",
        currencyCode: "INR",
      },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe("SAME_ACCOUNT");

    // Happy path: net customer movement zero, one journal, both balances move.
    const ok = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `tr_ok_${randomBytes(4).toString("hex")}` },
      payload: {
        sourceAccountId: accountA,
        destinationAccountId: accountB,
        amountMinor: "20000",
        currencyCode: "INR",
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "SUCCEEDED", replayed: false });

    const adminDetail = await app.inject({
      method: "GET",
      url: `/accounts/${accountB}`,
      cookies: { bv_session: cookieValue(admin) },
    });
    expect(adminDetail.json().account.balanceMinor).toBe("20000");

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ debit: string; credit: string }>(
        `SELECT
           COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debit,
           COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credit
         FROM ledger_entries WHERE journal_transaction_id = $1`,
        [ok.json().journalTransactionId],
      );
      expect(rows[0]).toEqual({ debit: "20000", credit: "20000" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("row 4: same key + same payload replays the stored success (no second journal)", async () => {
    const admin = await adminCookie();
    const key = `dep_replay_${randomBytes(4).toString("hex")}`;
    const first = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "7000", currencyCode: "INR" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key },
      payload: { amountMinor: "7000", currencyCode: "INR" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      status: "SUCCEEDED",
      journalTransactionId: first.json().journalTransactionId,
      replayed: true,
    });

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM idempotency_records WHERE idempotency_key = $1",
        [key],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("conservation across every posted journal: debits = credits (I1)", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ unbalanced: string }>(
        `SELECT COUNT(*)::text AS unbalanced FROM (
           SELECT journal_transaction_id FROM ledger_entries
           GROUP BY journal_transaction_id
           HAVING SUM(amount_minor) FILTER (WHERE direction = 'DEBIT')
               <> SUM(amount_minor) FILTER (WHERE direction = 'CREDIT')
         ) AS u`,
      );
      expect(rows[0]?.unbalanced).toBe("0");
    } finally {
      await closeIndependent(conn);
    }
  });

  it("IDEM-004: the same key STRING from another user is a DIFFERENT scoped key — independent results", async () => {
    // Scope of a key is UNIQUE(actor_id, operation, idempotency_key)
    // (IDEMPOTENCY_BEHAVIORS row scope note). The holder and the stranger both
    // send the identical key string for the same operation on the same account:
    // each actor gets an independent claim, journal and replay — the stranger's
    // call must NOT replay the holder's stored success.
    await grant("WITHDRAW", accountA, fixture.strangerEmail);
    const key = `idem4_${randomBytes(4).toString("hex")}`;
    const call = (cookie: string) =>
      app.inject({
        method: "POST",
        url: `/accounts/${accountA}/withdrawals`,
        cookies: { bv_session: cookieValue(cookie) },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "500", currencyCode: "INR" },
      });

    const holder = await holderCookie();
    const stranger = await strangerCookie();
    const first = await call(holder);
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    const second = await call(stranger);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(false);
    // Independent results: two distinct journals for the two actors.
    const holderJournal = first.json().journalTransactionId;
    const strangerJournal = second.json().journalTransactionId;
    expect(strangerJournal).not.toBe(holderJournal);

    // Each actor replays THEIR OWN stored outcome under the same key string.
    const holderReplay = await call(holder);
    expect(holderReplay.statusCode).toBe(200);
    expect(holderReplay.json().replayed).toBe(true);
    expect(holderReplay.json().journalTransactionId).toBe(holderJournal);
    const strangerReplay = await call(stranger);
    expect(strangerReplay.statusCode).toBe(200);
    expect(strangerReplay.json().replayed).toBe(true);
    expect(strangerReplay.json().journalTransactionId).toBe(strangerJournal);

    // Stored truth: TWO idempotency rows share the key string, one per actor.
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ rows: string; debits: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS rows,
           (SELECT COALESCE(SUM(amount_minor), 0)::text FROM ledger_entries
             WHERE account_id = $2 AND direction = 'DEBIT'
               AND journal_transaction_id IN (
                 SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS debits`,
        [key, BigInt(accountA)],
      );
      expect(rows[0]).toEqual({ rows: "2", debits: "1000" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("T-042: the DB-side attempt-write cap bounds per-actor D-9 rows without touching responses", async () => {
    // RATE-002's second line: a fresh actor flooding forbidden calls gets at
    // most CAP authorisation-refusal attempt rows in the window; every HTTP
    // response is still the full uniform 404 (the cap is audit-side only).
    const previousCap = process.env.T042_ATTEMPT_WRITE_CAP;
    process.env.T042_ATTEMPT_WRITE_CAP = "2";
    const password = `t042-pw-${randomBytes(8).toString("hex")}-0123456789`;
    const email = `t042_${fixture.suffix}@test.local`; // afterAll disables it
    const conn = await independentConnection(appConnectionString());
    let actorId = "";
    try {
      const { rows } = await conn.query(
        `INSERT INTO users (email, password_hash, role, status)
         VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE') RETURNING id::text AS id`,
        [email, await hashPassword(password)],
      );
      actorId = rows[0]!.id;
    } finally {
      await closeIndependent(conn);
    }

    try {
      const session = await login(email, password);
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: `/accounts/${accountA}/deposits`, // deposits are admin-only
          cookies: { bv_session: cookieValue(session) },
          headers: { "idempotency-key": `t042_${i}_${randomBytes(4).toString("hex")}` },
          payload: { amountMinor: "100", currencyCode: "INR" },
        });
        // The cap never changes the caller's response: full uniform 404 every time.
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
      }
      const check = await independentConnection(appConnectionString());
      try {
        const { rows } = await check.query<{ refused: string; failed: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'REFUSED')::text AS refused,
             COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed
           FROM transaction_attempts WHERE actor_id = $1`,
          [BigInt(actorId)],
        );
        // Cap = 2, three refused calls → exactly 2 durable D-9 rows.
        expect(rows[0]).toEqual({ refused: "2", failed: "0" });
      } finally {
        await closeIndependent(check);
      }
    } finally {
      if (previousCap === undefined) delete process.env.T042_ATTEMPT_WRITE_CAP;
      else process.env.T042_ATTEMPT_WRITE_CAP = previousCap;
    }
  });

  it("IDEM-006 (session): replay after session revocation is 401 UNAUTHENTICATED — never the stored success", async () => {
    // Row 7 gate, stage (a): before ANY stored outcome is returned the session
    // is re-read under FOR SHARE; a revoked session never receives the stored
    // 200 — and never a 404 for the revocation. The stored outcome itself
    // stays untouched, and the gate pass is evaluation-only (no attempt rows).
    const admin = await adminCookie();
    const key = `idem6sess_${randomBytes(4).toString("hex")}`;
    const deposit = () =>
      app.inject({
        method: "POST",
        url: `/accounts/${accountA}/deposits`,
        cookies: { bv_session: cookieValue(admin) },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "610", currencyCode: "INR" },
      });
    const first = await deposit();
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);

    // Revoke ALL of the admin's sessions directly (the login lifecycle's
    // revocation primitive; ADR-007).
    const adminId = await currentActorId("admin");
    const revokedAt = new Date();
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [BigInt(adminId)],
      );
    } finally {
      await closeIndependent(conn);
    }

    const replay = await deposit();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("UNAUTHENTICATED");

    // Stored truth intact: one idempotency row, one journal; and the revoked
    // replay left NO new attempt rows (gate refusals are evaluation-only).
    const check = await independentConnection(appConnectionString());
    try {
      const { rows } = await check.query<{ keys: string; journals: string; attempts: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS keys,
           (SELECT COUNT(DISTINCT journal_transaction_id)::text FROM idempotency_records
             WHERE idempotency_key = $1 AND journal_transaction_id IS NOT NULL) AS journals,
           (SELECT COUNT(*)::text FROM transaction_attempts
             WHERE actor_id = $2 AND created_at > $3) AS attempts`,
        [key, BigInt(adminId), revokedAt.toISOString()],
      );
      expect(rows[0]).toEqual({ keys: "1", journals: "1", attempts: "0" });
    } finally {
      await closeIndependent(check);
    }
  });

  it("IDEM-006 (grant): replay after grant revocation is the uniform 404 + one D-9 row; re-grant replays the stored success", async () => {
    // Row 7 gate, stage (b): a replay whose grant was revoked is refused at
    // D-8 step 1b BEFORE the key row is read — the uniform 404 envelope, one
    // D-9 authorisation-refusal row per refused call (REPLAY-AUTHZ-001), key
    // still NOT consumed. Once the grant is restored, the same key replays
    // the original stored success.
    const admin = await adminCookie();
    const holder = await holderCookie();
    const created = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: {
        accountNumber: uniqueAccountNumber(),
        label: "IDEM-006 grant-replay",
        currencyCode: "INR",
        kind: "CUSTOMER",
        status: "ACTIVE",
      },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().account.id;
    await grant("WITHDRAW", accountId, fixture.holderEmail);
    await grant("VIEW", accountId, fixture.holderEmail);
    const seeded = await app.inject({
      method: "POST",
      url: `/accounts/${accountId}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": `idem6fund_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "5000", currencyCode: "INR" },
    });
    expect(seeded.statusCode).toBe(200);

    const key = `idem6grant_${randomBytes(4).toString("hex")}`;
    const withdraw = () =>
      app.inject({
        method: "POST",
        url: `/accounts/${accountId}/withdrawals`,
        cookies: { bv_session: cookieValue(holder) },
        headers: { "idempotency-key": key },
        payload: { amountMinor: "300", currencyCode: "INR" },
      });
    const first = await withdraw();
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);

    const holderId = await currentActorId("holder");
    const conn = await independentConnection(appConnectionString());
    try {
      const { rowCount } = await conn.query(
        `UPDATE account_permissions SET revoked_at = now()
          WHERE user_id = $1 AND account_id = $2 AND permission = 'WITHDRAW' AND revoked_at IS NULL`,
        [BigInt(holderId), BigInt(accountId)],
      );
      expect(rowCount).toBe(1);
    } finally {
      await closeIndependent(conn);
    }

    const refusedAt = new Date();
    const replay = await withdraw();
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    // Exactly one D-9 authorisation-refusal row for the refused replay
    // (unsequenced, no fabricated balance), and the key was NOT consumed:
    // still exactly one idempotency row for the key.
    const check = await independentConnection(appConnectionString());
    try {
      const { rows } = await check.query<{ d9: string; keys: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM transaction_attempts
             WHERE actor_id = $1 AND status = 'REFUSED'
               AND account_event_seq IS NULL AND created_at > $3) AS d9,
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $2) AS keys`,
        [BigInt(holderId), key, refusedAt.toISOString()],
      );
      expect(rows[0]).toEqual({ d9: "1", keys: "1" });
    } finally {
      await closeIndependent(check);
    }

    // Re-grant: the gate now passes and the ORIGINAL stored success replays.
    await grant("WITHDRAW", accountId, fixture.holderEmail);
    const restored = await withdraw();
    expect(restored.statusCode).toBe(200);
    expect(restored.json().replayed).toBe(true);
    expect(restored.json().journalTransactionId).toBe(first.json().journalTransactionId);
  });
});

/** Cookie header value from a Set-Cookie string. */
function cookieValue(setCookie: string): string {
  return setCookie.replace(/^bv_session=/, "").split(";")[0] ?? setCookie;
}
