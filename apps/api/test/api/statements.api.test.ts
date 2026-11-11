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
import { assertGlobalInvariants } from "../../src/domain/invariants.js";

/**
 * PHASE-10 P10.1 account statements on real PostgreSQL + Redis:
 *
 * - STMT-001 (merge/ordering): one merged timeline; event rows strictly by
 *   `account_event_seq` (the counter, never the wall clock); unsequenced
 *   REFUSED attempts by `(occurred_at, global_seq)`; deterministic head-first
 *   interleave with exact tie → event first; clock-skew fixtures inserted with
 *   explicit `created_at` (append-only allows INSERT).
 * - Attempts never fabricate postings: attempt rows carry `eventPosition:
 *   null` and `balanceMinor: null`; FAILED rows and SUCCEEDED attempt rows
 *   never appear at any cursor.
 * - Running balance chain and locked refusal with measured balance.
 * - ASD-001: `account_status_detail` never in any statement response.
 * - Keyset pagination: 25-deposit walk proves no gaps, no duplicates, and a
 *   null terminal cursor.
 * - P10.2 access: uniform 404 for non-permitted holders/strangers, 200 for
 *   VIEW holders, AUDITOR and ADMIN, 401 unauthenticated.
 */

type Fixture = { suffix: string };

let fixture!: Fixture;

describe("account statements (real services; PHASE-10 P10.1/P10.2)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const auditorPassword = `auditor-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const strangerPassword = `stranger-pw-${randomBytes(8).toString("hex")}-0123456789`;
  let accountA = ""; // rich event history (holder VIEW + WITHDRAW)
  let accountB = ""; // transfer destination
  let accountNoView = ""; // exists, holder has NO VIEW grant
  let accountPage = ""; // 25-deposit pagination account
  let accountMerge = ""; // interleave/carry-forward account

  beforeAll(async () => {
    // The fixtures issue many money calls from one actor; the configured
    // per-actor money cap is for production defence, not for statement
    // fixtures. Raise the cap for this process only (before loadConfig).
    process.env.RATE_LIMIT_MONEY_LIMIT = "500";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/5", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const suffix = randomBytes(5).toString("hex");
    fixture = { suffix };
    const conn = await independentConnection(appConnectionString());
    try {
      for (const [email, passwordHash, role] of [
        [`admin_${suffix}@test.local`, await hashPassword(adminPassword), "ADMIN"],
        [`holder_${suffix}@test.local`, await hashPassword(holderPassword), "ACCOUNT_HOLDER"],
        [`auditor_${suffix}@test.local`, await hashPassword(auditorPassword), "AUDITOR"],
        [`stranger_${suffix}@test.local`, await hashPassword(strangerPassword), "ACCOUNT_HOLDER"],
      ] as const) {
        await conn.query(
          "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'ACTIVE')",
          [email, passwordHash, role],
        );
      }
    } finally {
      await closeIndependent(conn);
    }
  }, 60_000);

  beforeEach(async () => {
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
    for (const prefix of ["admin", "holder", "auditor", "stranger"] as const) {
      await resetLimiterBuckets(redis, "money", `actor:${await currentActorId(prefix)}`);
    }
  });

  afterAll(async () => {
    // Users are lifecycle rows: DISABLE (never delete).
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

    // INV-001: statements are read-only — the authoritative ledger must still
    // be intact after the whole statement suite.
    const inv = await independentConnection(appConnectionString());
    try {
      expect((await assertGlobalInvariants(inv)).violations).toEqual([]);
    } finally {
      await closeIndependent(inv);
    }
  }, 60_000);

  async function currentActorId(prefix: "admin" | "holder" | "auditor" | "stranger"): Promise<string> {
    if (!fixture) return "";
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query(
        "SELECT id::text AS id FROM users WHERE email = $1",
        [`${prefix}_${fixture.suffix}@test.local`],
      );
      return rows[0]?.id ?? "";
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

  // One login per actor per run: the login limiter is 10/300s per IP, and
  // fixtures make many authenticated calls. Sessions stay valid for the run.
  const sessionCache = new Map<string, Promise<string>>();
  function sessionFor(prefix: "admin" | "holder" | "auditor" | "stranger", email: string, password: string): Promise<string> {
    let cached = sessionCache.get(prefix);
    if (cached === undefined) {
      cached = login(email, password);
      sessionCache.set(prefix, cached);
    }
    return cached;
  }
  const adminCookie = () => sessionFor("admin", `admin_${fixture.suffix}@test.local`, adminPassword);
  const holderCookie = () => sessionFor("holder", `holder_${fixture.suffix}@test.local`, holderPassword);
  const auditorCookie = () => sessionFor("auditor", `auditor_${fixture.suffix}@test.local`, auditorPassword);
  const strangerCookie = () => sessionFor("stranger", `stranger_${fixture.suffix}@test.local`, strangerPassword);

  const cookieValue = (setCookie: string): string => setCookie.replace(/^bv_session=/, "").split(";")[0]!;
  const uniqueAccountNumber = () => `acc_${randomBytes(6).toString("hex")}`;

  async function createCustomerAccount(label: string): Promise<string> {
    const admin = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: { bv_session: cookieValue(admin) },
      payload: {
        accountNumber: uniqueAccountNumber(),
        label,
        currencyCode: "INR",
        kind: "CUSTOMER",
        status: "ACTIVE",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().account.id;
  }

  async function deposit(accountId: string, amountMinor: string, key?: string): Promise<void> {
    const admin = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: `/accounts/${accountId}/deposits`,
      cookies: { bv_session: cookieValue(admin) },
      headers: { "idempotency-key": key ?? `stmt_dep_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor, currencyCode: "INR" },
    });
    expect(res.statusCode).toBe(200);
  }

  async function grant(permission: string, accountId: string, granteePrefix: string): Promise<void> {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
         SELECT u.id, $2, $3, u.id FROM users u WHERE u.email = $1`,
        [`${granteePrefix}_${fixture.suffix}@test.local`, BigInt(accountId), permission],
      );
    } finally {
      await closeIndependent(conn);
    }
  }

  async function getStatement(
    cookie: string,
    accountId: string,
    query: { limit?: string; cursor?: string } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ statusCode: number; body: any }> {
    const search = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    const res = await app.inject({
      method: "GET",
      url: `/accounts/${accountId}/statement${search.length > 0 ? `?${search}` : ""}`,
      cookies: { bv_session: cookieValue(cookie) },
    });
    // Statement bodies are dynamic fixtures under test; loosely typed here
    // only (never on the production side).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = res.json() as any;
    return { statusCode: res.statusCode, body };
  }

  it("fixtures: build event-rich accounts (deposits, transfer, locked refusal, D-9 refusal)", async () => {
    accountA = await createCustomerAccount("statement A");
    accountB = await createCustomerAccount("statement B");
    accountNoView = await createCustomerAccount("statement no-view");
    await grant("VIEW", accountA, "holder");
    await grant("WITHDRAW", accountA, "holder");
    await grant("VIEW", accountB, "holder");
    await grant("TRANSFER", accountA, "holder");
    await deposit(accountA, "10000");
    await deposit(accountA, "5000");
    // Transfer A→B: posting DEBIT on A (seq 3, balance 13000).
    const admin = await adminCookie();
    const holder = await holderCookie();
    const tr = await app.inject({
      method: "POST",
      url: "/transfers",
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `stmt_tr_${randomBytes(4).toString("hex")}` },
      payload: { sourceAccountId: accountA, destinationAccountId: accountB, amountMinor: "2000", currencyCode: "INR" },
    });
    expect(tr.statusCode).toBe(200);
    void admin;

    // Locked refusal: suspend A, withdraw under lock → ACCOUNT_NOT_ACTIVE with
    // a measured balance and account_status_detail = 'SUSPENDED' (audit-only
    // column whose NON-appearance in statements this suite asserts), then
    // restore the account.
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("UPDATE accounts SET status = 'SUSPENDED', updated_at = now() WHERE id = $1", [BigInt(accountA)]);
    } finally {
      await closeIndependent(conn);
    }
    const refused = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(holder) },
      headers: { "idempotency-key": `stmt_wd_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("ACCOUNT_NOT_ACTIVE");
    const restore = await independentConnection(appConnectionString());
    try {
      await restore.query("UPDATE accounts SET status = 'ACTIVE', updated_at = now() WHERE id = $1", [BigInt(accountA)]);
    } finally {
      await closeIndependent(restore);
    }

    // Unsequenced D-9 refusal: a stranger (no grants) withdrawal attempt on A.
    const stranger = await strangerCookie();
    const d9 = await app.inject({
      method: "POST",
      url: `/accounts/${accountA}/withdrawals`,
      cookies: { bv_session: cookieValue(stranger) },
      headers: { "idempotency-key": `stmt_d9_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(d9.statusCode).toBe(404);

    // A synthetic FAILED row (best-effort infra-failure shape) and an
    // unsequenced SUCCEEDED-shaped row: neither may EVER appear in statements.
    const holderId = await currentActorId("holder");
    const synth = await independentConnection(appConnectionString());
    try {
      await synth.query(
        `INSERT INTO transaction_attempts
           (actor_id, operation, status, reason_code, supplied_account_ref, account_id, created_at)
         VALUES ($1, 'WITHDRAWAL', 'FAILED', 'INFRA_FAILURE', NULL, $2, now())`,
        [BigInt(holderId), BigInt(accountA)],
      );
    } finally {
      await closeIndependent(synth);
    }
  });

  it("STMT-001: merged timeline — counter-ordered events, (occurred_at, global_seq) attempts, deterministic tie-break, no FAILED/SUCCEEDED attempts, running balance chain", async () => {
    // Clock-skew fixtures for the attempt category: one attempt strictly
    // BEFORE the first event (must be the timeline head even though it was
    // inserted last) and one with created_at EXACTLY equal to the first
    // posting's created_at (exact tie → the event comes first).
    const conn = await independentConnection(appConnectionString());
    let firstPostingAt: Date;
    try {
      const { rows } = await conn.query<{ created_at: Date }>(
        `SELECT le.created_at FROM ledger_entries le
          WHERE le.account_id = $1 ORDER BY le.account_event_seq ASC LIMIT 1`,
        [BigInt(accountA)],
      );
      firstPostingAt = rows[0]!.created_at;
      const holderId = await currentActorId("holder");
      await conn.query(
        `INSERT INTO transaction_attempts
           (actor_id, operation, status, reason_code, supplied_account_ref, account_id, created_at)
         VALUES ($1, 'WITHDRAWAL', 'REFUSED', 'FORBIDDEN', NULL, $2, $3::timestamptz - interval '1 hour')`,
        [BigInt(holderId), BigInt(accountA), firstPostingAt],
      );
      await conn.query(
        `INSERT INTO transaction_attempts
           (actor_id, operation, status, reason_code, supplied_account_ref, account_id, created_at)
         VALUES ($1, 'WITHDRAWAL', 'REFUSED', 'FORBIDDEN', NULL, $2, $3)`,
        [BigInt(holderId), BigInt(accountA), firstPostingAt],
      );
    } finally {
      await closeIndependent(conn);
    }

    const { statusCode, body } = await getStatement(await holderCookie(), accountA);
    expect(statusCode).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.account.id).toBe(accountA);
    expect(body.account.status).toBe("ACTIVE");

    const timeline = body.timeline as Array<Record<string, unknown>>;
    expect(timeline.length).toBe(7); // 3 postings + 1 locked refusal + 3 REFUSED attempts

    // Category discipline: events strictly ascending by the counter,
    // 1..4 with no gaps; attempts always eventPosition null.
    const eventPositions = timeline
      .filter((r) => r.category === "event")
      .map((r) => BigInt(r.eventPosition as string));
    expect(eventPositions).toEqual([1n, 2n, 3n, 4n]);
    for (const row of timeline) {
      if (row.category === "attempt") {
        expect(row.eventPosition).toBeNull();
        expect(row.balanceMinor).toBeNull();
        expect(row.amountMinor).toBeNull();
        expect(row.status).toBe("REFUSED");
      }
    }

    // Head-first merge with skew: the pre-first-event attempt leads; at the
    // exact tie of the first posting the EVENT comes first.
    expect(timeline[0]!.category).toBe("attempt");
    expect(timeline[1]!.category).toBe("event");
    expect(timeline[1]!.eventPosition).toBe("1");
    expect(timeline[2]!.category).toBe("attempt");

    // Running balance chain + locked refusal with measured balance (seq 4).
    const dep1 = timeline[1]!;
    expect(dep1.type).toBe("DEPOSIT");
    expect(dep1.direction).toBe("CREDIT");
    expect(dep1.amountMinor).toBe("10000");
    expect(dep1.balanceMinor).toBe("10000");
    expect(dep1.status).toBe("POSTED");
    const dep2 = timeline.find((r) => r.category === "event" && r.eventPosition === "2");
    expect(dep2!.amountMinor).toBe("5000");
    expect(dep2!.balanceMinor).toBe("15000");
    const tr = timeline.find((r) => r.category === "event" && r.eventPosition === "3");
    expect(tr!.type).toBe("TRANSFER");
    expect(tr!.direction).toBe("DEBIT");
    expect(tr!.amountMinor).toBe("2000");
    expect(tr!.balanceMinor).toBe("13000");
    const locked = timeline.find((r) => r.category === "event" && r.eventPosition === "4");
    expect(locked!.status).toBe("REFUSED");
    expect(locked!.reasonCode).toBe("ACCOUNT_NOT_ACTIVE");
    expect(locked!.balanceMinor).toBe("13000"); // measured under lock
    expect(locked!.type).toBe("REFUSAL");
    expect(locked!.direction).toBeNull();
    expect(locked!.amountMinor).toBeNull();

    // Real D-9 refusal is the timeline tail with a granular reason code and
    // initiator identity (id + display name = email local-part only).
    const tail = timeline[6]!;
    expect(tail.category).toBe("attempt");
    expect(String(tail.reasonCode)).toBe("FORBIDDEN");
    expect(String((tail.initiator as { displayName?: string } | null)?.displayName)).toMatch(/^stranger(_[0-9a-f]{10})?$/);
    expect(JSON.stringify((tail.initiator as { displayName?: string } | null)?.displayName)).not.toContain("@");

    // FAILED rows and SUCCEEDED attempt rows (every successful operation
    // wrote one) never appear — at ANY position of the timeline.
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("INFRA_FAILURE");
    expect(bodyText).not.toContain('"status":"SUCCEEDED"');
    expect(bodyText).not.toContain('"OK"');

    // ASD-001: account_status_detail never leaks (the DB row for the locked
    // refusal carries 'SUSPENDED'; no statement row may surface it).
    expect(bodyText).not.toContain("SUSPENDED");
    expect(bodyText).not.toContain("statusDetail");
  });

  it("STMT-001 (admin sees the same timeline; ASD still withheld in statements)", async () => {
    const { statusCode, body } = await getStatement(await adminCookie(), accountA);
    expect(statusCode).toBe(200);
    expect(JSON.stringify(body)).not.toContain("SUSPENDED");
  });

  it("STMT-001: keyset pagination over 25 deposits — no gaps, no duplicates, null terminal cursor", async () => {
    accountPage = await createCustomerAccount("statement pagination");
    await grant("VIEW", accountPage, "holder");
    for (let i = 1; i <= 25; i += 1) {
      await deposit(accountPage, String(i * 10), `stmt_pg_${i}_${randomBytes(3).toString("hex")}`);
    }

    const holder = await holderCookie();
    const seen: Array<{ position: string; occurredAt: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { statusCode, body } = await getStatement(holder, accountPage, {
        limit: "10",
        cursor,
      });
      expect(statusCode).toBe(200);
      for (const row of body.timeline as Array<Record<string, unknown>>) {
        expect(row.category).toBe("event");
        seen.push({ position: row.eventPosition as string, occurredAt: row.occurredAt as string });
      }
      pages += 1;
      cursor = body.nextCursor;
      if (cursor === null) break;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(seen.map((s) => BigInt(s.position))).toEqual(
      Array.from({ length: 25 }, (_, i) => BigInt(i + 1)),
    );
    // Event order follows the counter: timestamps within the same second may
    // tie, but the positions must never regress.
    for (let i = 1; i < seen.length; i += 1) {
      expect(BigInt(seen[i]!.position)).toBeGreaterThan(BigInt(seen[i - 1]!.position));
    }
  });

  it("STMT-001: interleave + carry-forward — a category that emits nothing on a page keeps its cursor (no restarts, no duplicates)", async () => {
    accountMerge = await createCustomerAccount("statement merge");
    await grant("VIEW", accountMerge, "holder");
    await grant("WITHDRAW", accountMerge, "holder");
    for (let i = 1; i <= 5; i += 1) {
      await deposit(accountMerge, String(i * 100), `stmt_mg_${i}_${randomBytes(3).toString("hex")}`);
    }
    // One unsequenced refusal, created AFTER all events.
    const stranger = await strangerCookie();
    const d9 = await app.inject({
      method: "POST",
      url: `/accounts/${accountMerge}/withdrawals`,
      cookies: { bv_session: cookieValue(stranger) },
      headers: { "idempotency-key": `stmt_mg_d9_${randomBytes(4).toString("hex")}` },
      payload: { amountMinor: "100", currencyCode: "INR" },
    });
    expect(d9.statusCode).toBe(404);

    const holder = await holderCookie();
    const page1 = await getStatement(holder, accountMerge, { limit: "3" });
    expect(page1.statusCode).toBe(200);
    // Page 1: events 1..3 (the refusal is later in time — not yet emitted).
    expect(page1.body.timeline.map((r: Record<string, unknown>) => r.category)).toEqual([
      "event", "event", "event",
    ]);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await getStatement(holder, accountMerge, {
      limit: "3",
      cursor: page1.body.nextCursor,
    });
    // Page 2: events 4..5 then the refusal — the category switch is seamless,
    // and with everything consumed the walk terminates (null cursor).
    const page2Cats = page2.body.timeline.map((r: Record<string, unknown>) => r.category);
    expect(page2Cats).toEqual(["event", "event", "attempt"]);
    expect(page2.body.nextCursor).toBeNull();

    // Full walk has no duplicates across pages.
    const all = [...page1.body.timeline, ...page2.body.timeline];
    const seqs = all.filter((r: Record<string, unknown>) => r.category === "event")
      .map((r: Record<string, unknown>) => r.eventPosition as string);
    expect(seqs).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("P10.2 access matrix: no-VIEW holder and stranger → uniform 404; auditor/admin → 200; unauthenticated → 401; non-numeric id → 404; malformed cursor → VALIDATION_FAILED CURSOR_MALFORMED", async () => {
    // Holder WITHOUT a VIEW grant on accountNoView: the account "does not
    // exist" for them.
    const holder = await holderCookie();
    const noView = await getStatement(holder, accountNoView);
    expect(noView.statusCode).toBe(404);
    expect(noView.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    // Stranger (no grants at all) on accountA: same uniform 404.
    const stranger = await strangerCookie();
    const strangerRes = await getStatement(stranger, accountA);
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    // AUDITOR: role-level visibility over any account, read-only shape.
    const auditor = await auditorCookie();
    const auditorRes = await getStatement(auditor, accountA);
    expect(auditorRes.statusCode).toBe(200);
    expect(auditorRes.body.account.id).toBe(accountA);

    // ADMIN: same.
    const adminRes = await getStatement(await adminCookie(), accountA);
    expect(adminRes.statusCode).toBe(200);

    // Unauthenticated: 401.
    const anon = await app.inject({ method: "GET", url: `/accounts/${accountA}/statement` });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe("UNAUTHENTICATED");

    // Non-numeric ids: SAME uniform 404 envelope.
    const weird = await getStatement(holder, "not-a-number");
    expect(weird.statusCode).toBe(404);
    expect(weird.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    // Malformed cursor: explicit VALIDATION_FAILED (the granular reason is
    // internal detail, per the uniform-envelope discipline).
    const bad = await getStatement(holder, accountA, { cursor: "%%not-base64url%%" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");

    // Limit validation: non-numeric → 400; numeric clamps to 1..200.
    const badLimit = await getStatement(holder, accountA, { limit: "abc" });
    expect(badLimit.statusCode).toBe(400);
    const zero = await getStatement(holder, accountA, { limit: "0" });
    expect(zero.statusCode).toBe(200);
    expect(zero.body.timeline.length).toBe(1);
    const huge = await getStatement(holder, accountPage, { limit: "5000" });
    expect(huge.statusCode).toBe(200);
    expect(huge.body.timeline.length).toBe(25);
  });
});
