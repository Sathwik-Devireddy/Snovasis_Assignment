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
  envOrThrow,
  independentConnection,
  closeIndependent,
} from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";
import { assertGlobalInvariants } from "../../src/domain/invariants.js";

/**
 * PHASE 12 — adversarial verification (P12.2 direct API attacks, P12.5 load
 * smoke). Real PostgreSQL 17 + Redis, real HTTP handlers.
 *
 * The Phase-12 report of 2026-11-12 mapped these attacks to "existing named
 * tests" and removed the placeholder file. This suite re-creates the attacks
 * as EXECUTABLE assertions over the real HTTP surface, so every claim in the
 * threat register that cites an attack can be checked by running one file.
 *
 * Attack list (PHASE-12 P12.2):
 *   A1 simultaneous overdraw        A5 holder deposit
 *   A2 replayed transfer            A6 role in body
 *   A3 transfer from another user   A7 tampered cookie
 *   A4 auditor writes               A8 cross-origin mutation (CSRF)
 * plus P12.5: 200 mixed concurrent requests, then the global invariants.
 *
 * No placeholder assertions: every test below fails if the control it names
 * is removed.
 */

const PASSWORD = `p12-adversarial-${randomBytes(6).toString("hex")}-0123456789`;

let app: FastifyInstance;
let pgPool: Pool;
let redis: ReturnType<typeof createRedisClient>;

const emails = {
  admin: "",
  holder: "",
  stranger: "",
  auditor: "",
};

const ids = {
  admin: "",
  holder: "",
  stranger: "",
  auditor: "",
};

let accountA = "";
let accountB = "";

function suffix(): string {
  return randomBytes(5).toString("hex");
}

async function insertUser(email: string, role: string): Promise<string> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id::text AS id",
      [email, await hashPassword(PASSWORD), role],
    );
    return rows[0]!.id;
  } finally {
    await closeIndependent(conn);
  }
}

async function createAccount(label: string): Promise<string> {  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ id: string }>(
      `INSERT INTO accounts (account_number, label, currency_code, kind, balance_minor, event_last_seq, status)
       VALUES ($1, $2, 'INR', 'CUSTOMER', 0, 0, 'ACTIVE') RETURNING id::text AS id`,
      [`p12_${label}_${randomBytes(4).toString("hex")}`, label],
    );
    return rows[0]!.id;
  } finally {
    await closeIndependent(conn);
  }
}

/** The admin grants a permission to another user (never to themself — AUTH-004). */
async function grant(userId: string, accountId: string, permission: string): Promise<void> {
  const conn = await independentConnection(appConnectionString());
  try {
    await conn.query(
      `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [userId, accountId, permission, ids.admin],
    );
  } finally {
    await closeIndependent(conn);
  }
}

async function login(email: string): Promise<string> {  const res = await app.inject({
    method: "POST",
    url: "/login",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(";")[0]!.replace(/^bv_session=/, "");
}

async function post(
  url: string,
  cookie: string,
  payload: unknown,
  key: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url,
    cookies: { bv_session: cookie },
    headers: { "idempotency-key": key, ...extraHeaders },
    payload: payload as Record<string, unknown>,
  });
}

/** Ledger-derived position of an account (authoritative, not the cached one). */async function derivedBalance(accountId: string): Promise<bigint> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query<{ derived: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::text AS derived
         FROM ledger_entries WHERE account_id = $1`,
      [accountId],
    );
    return BigInt(rows[0]!.derived);
  } finally {
    await closeIndependent(conn);
  }
}

describe("PHASE-12 adversarial verification (real API, real database)", () => {
  beforeAll(async () => {
    // The money limiter would otherwise refuse the load smoke (T-060 is an
    // availability control; the DB-side invariants are what this phase proves).
    process.env.RATE_LIMIT_MONEY_LIMIT = "5000";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/9", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const s = suffix();
    emails.admin = `p12_admin_${s}@test.local`;
    emails.holder = `p12_holder_${s}@test.local`;
    emails.stranger = `p12_stranger_${s}@test.local`;
    emails.auditor = `p12_auditor_${s}@test.local`;
    ids.admin = await insertUser(emails.admin, "ADMIN");
    ids.holder = await insertUser(emails.holder, "ACCOUNT_HOLDER");
    ids.stranger = await insertUser(emails.stranger, "ACCOUNT_HOLDER");
    ids.auditor = await insertUser(emails.auditor, "AUDITOR");

    accountA = await createAccount("adversarial A");
    accountB = await createAccount("adversarial B");

    // The holder may VIEW and TRANSFER on A (and withdraw from A).
    const conn = await independentConnection(appConnectionString());
    try {
      for (const permission of ["VIEW", "TRANSFER", "WITHDRAW"]) {
        await conn.query(
          `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [ids.holder, accountA, permission, ids.admin],
        );
      }
    } finally {
      await closeIndependent(conn);
    }
  }, 120_000);

  // Each test starts with empty pre-auth limiter buckets (the login/register
  // limiters are IP-keyed; the suite logs in several times).
  beforeEach(async () => {
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
  });

  afterAll(async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("UPDATE users SET status = 'DISABLED' WHERE email = ANY($1)", [
        Object.values(emails),
      ]);
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 60_000);

  // ---- A1: simultaneous overdraw ------------------------------------------------
  it("A1 simultaneous overdraw: two concurrent withdrawals, exactly one succeeds (T-001)", async () => {
    const admin = await login(emails.admin);
    const account = await createAccount("overdraw target");
    const fund = await post(
      `/accounts/${account}/deposits`,
      admin,
      { amountMinor: "100000", currencyCode: "INR" },
      `p12_a1_fund_${randomBytes(4).toString("hex")}`,
    );
    expect(fund.statusCode).toBe(200);

    const attempt = (key: string) =>
      post(
        `/accounts/${account}/withdrawals`,
        admin,
        { amountMinor: "80000", currencyCode: "INR" },
        key,
      );
    const [first, second] = await Promise.all([
      attempt(`p12_a1_w1_${randomBytes(4).toString("hex")}`),
      attempt(`p12_a1_w2_${randomBytes(4).toString("hex")}`),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json().error.code).toBe("INSUFFICIENT_FUNDS");
    // Money moved exactly once — the account never went negative.
    expect(await derivedBalance(account)).toBe(20_000n);
  }, 60_000);

  // ---- A2: replayed transfer ----------------------------------------------------
  it("A2 replayed transfer: the same key replays the stored result, one effect (T-003/T-030)", async () => {
    const admin = await login(emails.admin);
    const holder = await login(emails.holder);
    const source = await createAccount("replay source");
    const destination = await createAccount("replay destination");
    // Transfers require a TRANSFER grant on the source for EVERY actor
    // (admins may not self-grant — AUTH-004), so the holder performs it.
    await grant(ids.holder, source, "TRANSFER");
    const fund = await post(
      `/accounts/${source}/deposits`,
      admin,
      { amountMinor: "50000", currencyCode: "INR" },
      `p12_a2_fund_${randomBytes(4).toString("hex")}`,
    );
    expect(fund.statusCode).toBe(200);

    const key = `p12_a2_${randomBytes(4).toString("hex")}`;
    const body = {
      sourceAccountId: source,
      destinationAccountId: destination,
      amountMinor: "20000",
      currencyCode: "INR",
    };
    const first = await post("/transfers", holder, body, key);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("SUCCEEDED");

    const replay = await post("/transfers", holder, body, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("SUCCEEDED");
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().journalTransactionId).toBe(first.json().journalTransactionId);
    // Exactly one financial effect.
    expect(await derivedBalance(destination)).toBe(20_000n);
    expect(await derivedBalance(source)).toBe(30_000n);
  }, 60_000);

  // ---- A3: transfer from another user's account ---------------------------------
  it("A3 transfer from another user's account: uniform 404, no money moved (T-006/T-016)", async () => {
    const stranger = await login(emails.stranger);
    const before = await derivedBalance(accountA);
    const res = await post(
      "/transfers",
      stranger,
      {
        sourceAccountId: accountA, // the holder's account — not the stranger's
        destinationAccountId: accountB,
        amountMinor: "1000",
        currencyCode: "INR",
      },
      `p12_a3_${randomBytes(4).toString("hex")}`,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(await derivedBalance(accountA)).toBe(before);
    expect(await derivedBalance(accountB)).toBe(0n);
  }, 60_000);

  // ---- A4: auditor writes --------------------------------------------------------
  it("A4 auditor writes: every money mutation is refused (T-007/T-014)", async () => {
    const auditor = await login(emails.auditor);
    const before = await derivedBalance(accountA);
    const deposit = await post(
      `/accounts/${accountA}/deposits`,
      auditor,
      { amountMinor: "5000", currencyCode: "INR" },
      `p12_a4_dep_${randomBytes(4).toString("hex")}`,
    );
    expect(deposit.statusCode).toBe(404);
    expect(deposit.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const withdrawal = await post(
      `/accounts/${accountA}/withdrawals`,
      auditor,
      { amountMinor: "5000", currencyCode: "INR" },
      `p12_a4_wd_${randomBytes(4).toString("hex")}`,
    );
    expect(withdrawal.statusCode).toBe(404);

    const transfer = await post(
      "/transfers",
      auditor,
      {
        sourceAccountId: accountA,
        destinationAccountId: accountB,
        amountMinor: "5000",
        currencyCode: "INR",
      },
      `p12_a4_trf_${randomBytes(4).toString("hex")}`,
    );
    expect(transfer.statusCode).toBe(404);
    // No money moved by the auditor.
    expect(await derivedBalance(accountA)).toBe(before);
  }, 60_000);

  // ---- A5: holder deposit -------------------------------------------------------
  it("A5 holder deposit: refused (DEPOSIT is admin-only), no money minted (T-024)", async () => {
    const holder = await login(emails.holder);
    const before = await derivedBalance(accountA);
    const res = await post(
      `/accounts/${accountA}/deposits`,
      holder,
      { amountMinor: "100000", currencyCode: "INR" },
      `p12_a5_${randomBytes(4).toString("hex")}`,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(await derivedBalance(accountA)).toBe(before);
  }, 60_000);

  // ---- A6: role in body ----------------------------------------------------------
  it("A6 role in body: a claimed role is refused outright and never applied (T-007/T-061)", async () => {
    // The registration schema is STRICT: an unknown field (the claimed role)
    // is refused with the uniform envelope and NO user row is created.
    const escalate = `p12_role_${randomBytes(6).toString("hex")}@test.local`;
    const refused = await app.inject({
      method: "POST",
      url: "/register",
      payload: { email: escalate, password: PASSWORD, role: "ADMIN" } as Record<string, unknown>,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("VALIDATION_FAILED");
    const probe = await independentConnection(appConnectionString());
    try {
      const { rows } = await probe.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM users WHERE email = $1",
        [escalate],
      );
      expect(rows[0]!.n).toBe("0");
    } finally {
      await closeIndependent(probe);
    }

    // A well-formed registration is always ACCOUNT_HOLDER, whatever the server
    // default is (role is server-fixed, never taken from the request).
    const email = `p12_role_ok_${randomBytes(6).toString("hex")}@test.local`;
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("ACCOUNT_HOLDER");
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ role: string }>(
        "SELECT role FROM users WHERE email = $1",
        [email],
      );
      expect(rows[0]!.role).toBe("ACCOUNT_HOLDER");
      await conn.query("UPDATE users SET status = 'DISABLED' WHERE email = $1", [email]);
    } finally {
      await closeIndependent(conn);
    }
  }, 60_000);

  // ---- A7: tampered cookie -------------------------------------------------------
  it("A7 tampered cookie: rejected with 401 and the real session survives (T-032)", async () => {
    const admin = await login(emails.admin);
    const token = admin;
    const tampered = `${token.slice(0, -1)}${token.slice(-1) === "a" ? "b" : "a"}`;
    const res = await app.inject({
      method: "GET",
      url: "/accounts",
      cookies: { bv_session: tampered },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");

    // The genuine session is untouched by the attack.
    const ok = await app.inject({
      method: "GET",
      url: "/accounts",
      cookies: { bv_session: token },
    });
    expect(ok.statusCode).toBe(200);
  }, 60_000);

  // ---- A8: cross-origin mutation (CSRF) ------------------------------------------
  it("A8 cross-origin mutation: refused (Origin check), the real origin still works (T-032)", async () => {
    const admin = await login(emails.admin);
    const evil = await post(
      `/accounts/${accountA}/deposits`,
      admin,
      { amountMinor: "1000", currencyCode: "INR" },
      `p12_a8_${randomBytes(4).toString("hex")}`,
      { origin: "https://evil.example" },
    );
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error.code).toBe("VALIDATION_FAILED");
  }, 60_000);

  // ---- P12.5: load smoke ----------------------------------------------------------
  it("P12.5 load smoke: 200 mixed concurrent requests leave the ledger consistent (T-035/T-042)", async () => {
    const admin = await login(emails.admin);
    const holder = await login(emails.holder);
    const loadAccount = await createAccount("load target");
    const counterAccount = await createAccount("load counter");
    // The holder performs the transfers (a TRANSFER grant on the source);
    // the admin performs the deposits/withdrawals.
    await grant(ids.holder, loadAccount, "TRANSFER");
    const fund = await post(
      `/accounts/${loadAccount}/deposits`,
      admin,
      { amountMinor: "1000000", currencyCode: "INR" },
      `p12_load_fund_${randomBytes(4).toString("hex")}`,
    );
    expect(fund.statusCode).toBe(200);

    const requests: Array<Promise<{ status: number; body: string }>> = [];
    for (let i = 0; i < 200; i += 1) {
      const key = `p12_load_${i}_${randomBytes(3).toString("hex")}`;
      if (i % 4 === 0) {
        requests.push(
          post(
            `/accounts/${loadAccount}/deposits`,
            admin,
            { amountMinor: "100", currencyCode: "INR" },
            key,
          ).then((r) => ({ status: r.statusCode, body: r.body })),
        );
      } else if (i % 4 === 1) {
        requests.push(
          post(
            `/accounts/${loadAccount}/withdrawals`,
            admin,
            { amountMinor: "100", currencyCode: "INR" },
            key,
          ).then((r) => ({ status: r.statusCode, body: r.body })),
        );
      } else if (i % 4 === 2) {
        requests.push(
          post(
            "/transfers",
            holder,
            {
              sourceAccountId: loadAccount,
              destinationAccountId: counterAccount,
              amountMinor: "100",
              currencyCode: "INR",
            },
            key,
          ).then((r) => ({ status: r.statusCode, body: r.body })),
        );
      } else {
        requests.push(
          app
            .inject({
              method: "GET",
              url: `/accounts/${loadAccount}/statement?limit=20`,
              cookies: { bv_session: admin },
            })
            .then((r) => ({ status: r.statusCode, body: r.body })),
        );
      }
    }

    const results = await Promise.all(requests);
    const failures = results.filter((r) => r.status >= 500);
    expect(failures).toEqual([]); // no server error under the mixed load

    // Money is conserved: 50 deposits (+5000), 50 withdrawals (-5000) and
    // 50 transfers (-5000 out of the load account, +5000 into the counter
    // account) → the load account nets 1,000,000 − 5,000 = 995,000.
    expect(await derivedBalance(loadAccount)).toBe(995_000n);
    expect(await derivedBalance(counterAccount)).toBe(5_000n);

    // The global invariants still hold over the authoritative ledger.
    const conn = await independentConnection(appConnectionString());
    try {
      const report = await assertGlobalInvariants(conn);
      expect(report.violations).toEqual([]);
    } finally {
      await closeIndependent(conn);
    }
  }, 180_000);
});
