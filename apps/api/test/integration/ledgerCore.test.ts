import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  appConnectionString,
  ownerConnectionString,
  independentConnection,
  closeIndependent,
} from "../harness.js";
import { runMoneyCommand } from "../../src/domain/transactionRunner.js";
import { canonicalHash } from "../../src/domain/money.js";
import { assertGlobalInvariants } from "../../src/domain/invariants.js";
import { DomainError } from "../../src/http/errors.js";

/**
 * PHASE-06 P6.8 invariants + concurrency, directly against real PostgreSQL
 * (no HTTP layer — these are DB-level guarantees the app relies on):
 *
 * - LED-001/LED-002: the append-only set (journal_transactions, ledger_entries,
 *   transaction_attempts, audit_events) refuses UPDATE/DELETE/TRUNCATE at the
 *   runtime role — row triggers plus the absence of privileges.
 * - JBL-001: unbalanced or zero-entry journals are rejected by the deferred
 *   constraint triggers at COMMIT (assert_journal_balanced).
 * - CHECK constraints: no overdraft (accounts_no_overdraft); SYSTEM rows
 *   never carry a cached balance (accounts_customer_shape).
 * - CON-001 (withdrawal race): two concurrent withdrawals from the same
 *   account over its balance — exactly one succeeds; the FOR UPDATE row lock
 *   makes the loser read the post-debit balance and refuse under lock.
 * - IDEM-003 (same-key race): two concurrent identical commands sharing one
 *   idempotency key — one execution total; the loser replays the stored
 *   outcome with the same journal id (the DB unique row IS the mutex).
 */

let seedSuffix = "";

describe("ledger core invariants + races (real PostgreSQL; P6.8/CON-001/IDEM-003)", () => {
  // Accounts created once; the balanced two-entry journal seeds the
  // append-only tests with real rows to attack.
  let accountX = 0n;
  let accountY = 0n;
  let holderId = 0n;
  let holderSessionId = 0n;
  let adminId = 0n;
  let adminSessionId = 0n;
  const actorPassword = `race-pw-${randomBytes(8).toString("hex")}-0123456789`;
  void actorPassword;

  beforeAll(async () => {
    const suffix = randomBytes(5).toString("hex");
    seedSuffix = suffix;
    const conn = await independentConnection(appConnectionString());
    try {
      const mkUser = async (email: string, role: string): Promise<bigint> => {
        const { rows } = await conn.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, status)
           VALUES ($1, $2, $3, 'ACTIVE') RETURNING id::text AS id`,
          [email, `stub-hash-${randomBytes(4).toString("hex")}`, role],
        );
        return BigInt(rows[0]!.id);
      };
      const mkSession = async (userId: bigint): Promise<bigint> => {
        const { rows } = await conn.query<{ id: string }>(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '1 hour') RETURNING id::text AS id`,
          [userId, `race-token-${randomBytes(8).toString("hex")}`],
        );
        return BigInt(rows[0]!.id);
      };
      holderId = await mkUser(`race_holder_${suffix}@test.local`, "ACCOUNT_HOLDER");
      adminId = await mkUser(`race_admin_${suffix}@test.local`, "ADMIN");
      holderSessionId = await mkSession(holderId);
      adminSessionId = await mkSession(adminId);
      const mkAccount = async (label: string): Promise<bigint> => {
        const { rows } = await conn.query<{ id: string }>(
          `INSERT INTO accounts (account_number, label, currency_code, kind, status, balance_minor, event_last_seq)
           VALUES ($1, $2, 'INR', 'CUSTOMER', 'ACTIVE', 0, 0) RETURNING id::text AS id`,
          [`race_${randomBytes(6).toString("hex")}`, label],
        );
        return BigInt(rows[0]!.id);
      };
      accountX = await mkAccount("race X");
      accountY = await mkAccount("race Y");
      await conn.query(
        `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
         VALUES ($1, $2, 'TRANSFER', $1), ($1, $2, 'WITHDRAW', $1), ($1, $2, 'VIEW', $1)`,
        [holderId, accountX],
      );
    } finally {
      await closeIndependent(conn);
    }
  }, 40_000);

  afterAll(async () => {
    // Users are lifecycle rows: DISABLE them FIRST so the cleanup runs even if
    // the invariant check below fails (a skipped cleanup leaves active fixture
    // users that break other suites running against the same dev database).
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1",
        [`race_%_${seedSuffix}@test.local`],
      );
    } finally {
      await closeIndependent(conn);
    }
    // INV-001 over the whole authoritative ledger after the suite's races:
    // gap-free shared event counter per account, stored == ledger-derived
    // balances, every journal balanced (P6.7 / src/domain/invariants.ts).
    const inv = await independentConnection(appConnectionString());
    try {
      const report = await assertGlobalInvariants(inv);
      expect(report.violations).toEqual([]);
    } finally {
      await closeIndependent(inv);
    }
  }, 40_000);

  it("LED-001: the append-only set refuses UPDATE and DELETE at the runtime role", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows: journalRows } = await conn.query<{ id: string }>(
        "SELECT id::text AS id FROM journal_transactions ORDER BY id DESC LIMIT 1",
      );
      expect(journalRows.length).toBeGreaterThan(0);

      // First layer: privilege denial — the runtime role holds no UPDATE/DELETE.
      await expect(
        conn.query("UPDATE journal_transactions SET description = 'tampered' WHERE id = $1", [journalRows[0]!.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        conn.query("DELETE FROM ledger_entries WHERE id = (SELECT MIN(id) FROM ledger_entries)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        conn.query("UPDATE transaction_attempts SET reason_code = 'HACKED' WHERE id = (SELECT MIN(id) FROM transaction_attempts)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        conn.query("DELETE FROM audit_events WHERE id = (SELECT MIN(id) FROM audit_events)"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("LED-002: TRUNCATE on the append-only set is refused", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await expect(conn.query("TRUNCATE ledger_entries")).rejects.toMatchObject({ code: "42501" });
      await expect(conn.query("TRUNCATE journal_transactions")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("LED-001b: the row triggers fire even for the PRIVILEGED owner role (second layer)", async () => {
    // The owner holds every privilege, so refusal can only come from the
    // triggers — which fire for EVERY session (schema-draft grants comment;
    // the sole ALTER TABLE ... DISABLE TRIGGER bypass is the disclosed T-026).
    const conn = await independentConnection(ownerConnectionString());
    try {
      await expect(
        conn.query("UPDATE journal_transactions SET description = 'tampered' WHERE id = (SELECT MAX(id) FROM journal_transactions)"),
      ).rejects.toThrow(/append-only violation/);
      await expect(
        conn.query("DELETE FROM ledger_entries WHERE id = (SELECT MAX(id) FROM ledger_entries)"),
      ).rejects.toThrow(/append-only violation/);
      await expect(
        conn.query("UPDATE transaction_attempts SET reason_code = 'HACKED' WHERE id = (SELECT MAX(id) FROM transaction_attempts)"),
      ).rejects.toThrow(/append-only violation/);
      await expect(
        conn.query("DELETE FROM audit_events WHERE id = (SELECT MAX(id) FROM audit_events)"),
      ).rejects.toThrow(/append-only violation/);
      await expect(conn.query("TRUNCATE ledger_entries")).rejects.toThrow(/append-only violation/);
      // journal_transactions carries FKs (ledger_entries, idempotency_records):
      // PostgreSQL's dependent-objects check refuses the TRUNCATE before the
      // row trigger can fire — either mechanism is a valid refusal.
      await expect(conn.query("TRUNCATE journal_transactions")).rejects.toThrow(
        /append-only violation|foreign key/,
      );
    } finally {
      await closeIndependent(conn);
    }
  });

  it("JBL-001: unbalanced and zero-entry journals are rejected at COMMIT", async () => {
    // Zero-entry journal: caught by the journal_transactions constraint trigger.
    const zero = await independentConnection(appConnectionString());
    try {
      await zero.query("BEGIN");
      await zero.query(
        `INSERT INTO journal_transactions (type, status, currency_code, initiated_by)
         VALUES ('TRANSFER', 'POSTED', 'INR', $1)`,
        [adminId],
      );
      await expect(zero.query("COMMIT")).rejects.toThrow(/0 entries/);
    } catch (error) {
      await zero.query("ROLLBACK").catch(() => undefined);
      await closeIndependent(zero);
      throw error;
    }
    await closeIndependent(zero);

    // Unbalanced two-row journal: caught by the ledger_entries trigger at COMMIT.
    const unbalanced = await independentConnection(appConnectionString());
    try {
      await unbalanced.query("BEGIN");
      const { rows: journalRows } = await unbalanced.query<{ id: string }>(
        `INSERT INTO journal_transactions (type, status, currency_code, initiated_by)
         VALUES ('TRANSFER', 'POSTED', 'INR', $1) RETURNING id::text AS id`,
        [adminId],
      );
      // NOTE: never pick "the latest journal" with ORDER BY id on a text-cast
      // output alias — PostgreSQL resolves ORDER BY to the OUTPUT column name
      // first, which sorts lexicographically ("9" > "16") and can hijack a
      // COMMITTED journal. RETURNING id is authoritative.
      const journalId = BigInt(journalRows[0]!.id);
      await unbalanced.query(
        `INSERT INTO ledger_entries (journal_transaction_id, account_id, direction, amount_minor, currency_code)
         VALUES ($1, $2, 'DEBIT', 100, 'INR')`,
        [journalId, accountX],
      );
      await unbalanced.query(
        `INSERT INTO ledger_entries (journal_transaction_id, account_id, direction, amount_minor, currency_code)
         VALUES ($1, $2, 'CREDIT', 99, 'INR')`,
        [journalId, accountY],
      );
      await expect(unbalanced.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } catch (error) {
      await unbalanced.query("ROLLBACK").catch(() => undefined);
      await closeIndependent(unbalanced);
      throw error;
    }
    await closeIndependent(unbalanced);
  });

  it("CHECK constraints: no overdraft; SYSTEM rows carry no cached balance", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await expect(
        conn.query("UPDATE accounts SET balance_minor = -1 WHERE id = $1", [accountX]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        conn.query(
          "UPDATE accounts SET balance_minor = 5 WHERE account_number = 'EXTERNAL_CLEARING'",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await closeIndependent(conn);
    }
  });

  it("CON-001: concurrent over-balance withdrawals — exactly one succeeds", async () => {
    // Fund the account deterministically first (500 minor units).
    const setup = await independentConnection(appConnectionString());
    let funded: bigint;
    try {
      const result = await runMoneyCommand(setup, {
        operation: "DEPOSIT",
        idempotencyKey: `race_fund_${randomBytes(4).toString("hex")}`,
        requestHash: canonicalHash({ seed: randomBytes(4).toString("hex") }),
        actorId: adminId,
        sessionId: adminSessionId,
        destinationAccountId: accountX,
        amount: 500n,
        currencyCode: "INR",
      });
      funded = result.journalTransactionId;
      expect(result.replayed).toBe(false);
    } finally {
      await closeIndependent(setup);
    }
    void funded;

    // Two independent connections race two 400-unit withdrawals.
    const c1 = await independentConnection(appConnectionString());
    const c2 = await independentConnection(appConnectionString());
    const mkCommand = (key: string) => ({
      operation: "WITHDRAWAL" as const,
      idempotencyKey: key,
      requestHash: canonicalHash({ op: "WITHDRAWAL", key, amount: "400", currency: "INR" }),
      actorId: holderId,
      sessionId: holderSessionId,
      sourceAccountId: accountX,
      amount: 400n,
      currencyCode: "INR",
    });
    const [r1, r2] = await Promise.allSettled([
      runMoneyCommand(c1, mkCommand(`race_a_${randomBytes(3).toString("hex")}`)),
      runMoneyCommand(c2, mkCommand(`race_b_${randomBytes(3).toString("hex")}`)),
    ]);
    await closeIndependent(c1);
    await closeIndependent(c2);

    const outcomes = [r1, r2].map((r) => (r.status === "fulfilled" ? "SUCCEEDED" : reasonOf(r.reason)));
    expect(outcomes.sort()).toEqual(["INSUFFICIENT_FUNDS", "SUCCEEDED"]);

    // Final stored balance is 500 - 400 = 100 AND equals the ledger-derived
    // total (P6.7 invariant: stored = Σcredits − Σdebits for the account);
    // the GLOBAL ledger stays conserved (every journal debits = credits).
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ balance: string; derived: string; global: string }>(
        `SELECT
           (SELECT balance_minor::text FROM accounts WHERE id = $1) AS balance,
           (SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'), 0)
              - COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'), 0)
            FROM ledger_entries WHERE account_id = $1)::text AS derived,
           (SELECT COUNT(*)::text FROM (
              SELECT journal_transaction_id FROM ledger_entries
              GROUP BY journal_transaction_id
              HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'), 0)
                  <> COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'), 0)
            ) AS u) AS global`,
        [accountX],
      );
      expect(rows[0]!.balance).toBe("100");
      expect(rows[0]!.derived).toBe("100");
      expect(rows[0]!.global).toBe("0");
    } finally {
      await closeIndependent(conn);
    }
  }, 40_000);

  it("IDEM-003: concurrent same-key commands — one execution, loser replays", async () => {
    const c1 = await independentConnection(appConnectionString());
    const c2 = await independentConnection(appConnectionString());
    const key = `race_key_${randomBytes(4).toString("hex")}`;
    const mkCommand = () => ({
      operation: "DEPOSIT" as const,
      idempotencyKey: key,
      requestHash: canonicalHash({ op: "DEPOSIT", amount: "250", currency: "INR", key }),
      actorId: adminId,
      sessionId: adminSessionId,
      destinationAccountId: accountY,
      amount: 250n,
      currencyCode: "INR",
    });
    const [r1, r2] = await Promise.allSettled([
      runMoneyCommand(c1, mkCommand()),
      runMoneyCommand(c2, mkCommand()),
    ]);
    await closeIndependent(c1);
    await closeIndependent(c2);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const v1 = (r1 as PromiseFulfilledResult<{ journalTransactionId: bigint; replayed: boolean }>).value;
    const v2 = (r2 as PromiseFulfilledResult<{ journalTransactionId: bigint; replayed: boolean }>).value;
    expect(v1.journalTransactionId).toBe(v2.journalTransactionId);
    expect([v1.replayed, v2.replayed].sort()).toEqual([false, true]);

    // Exactly ONE journal for the key; exactly 250 moved once.
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ journals: string; credited: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS journals,
           (SELECT COALESCE(SUM(amount_minor), 0)::text FROM ledger_entries
             WHERE account_id = $2 AND direction = 'CREDIT'
               AND journal_transaction_id = (SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS credited`,
        [key, accountY],
      );
      expect(rows[0]).toEqual({ journals: "1", credited: "250" });
    } finally {
      await closeIndependent(conn);
    }
  }, 40_000);

  it("IDEM-005: lost response — commit succeeds, client retries with the SAME key, stored result replays", async () => {
    // Row 10: commit succeeded, response lost. The prescribed client behavior
    // is a retry with the SAME key — the replay gate returns the stored
    // outcome marked replayed: true, with NO second journal.
    const conn = await independentConnection(appConnectionString());
    const key = `idem005_${randomBytes(4).toString("hex")}`;
    const command = () => ({
      operation: "DEPOSIT" as const,
      idempotencyKey: key,
      requestHash: canonicalHash({ op: "DEPOSIT", amount: "750", currency: "INR", key }),
      actorId: adminId,
      sessionId: adminSessionId,
      destinationAccountId: accountY,
      amount: 750n,
      currencyCode: "INR",
    });
    try {
      const first = await runMoneyCommand(conn, command());
      expect(first.replayed).toBe(false);
      // The "lost response": a fresh sequential execution on the SAME key.
      const retryConn = await independentConnection(appConnectionString());
      try {
        const retry = await runMoneyCommand(retryConn, command());
        expect(retry.replayed).toBe(true);
        expect(retry.journalTransactionId).toBe(first.journalTransactionId);
      } finally {
        await closeIndependent(retryConn);
      }
      // Stored truth: exactly one idempotency row; exactly one 750 credit.
      const check = await independentConnection(appConnectionString());
      try {
        const { rows } = await check.query<{ keys: string; journals: string; credited: string }>(
          `SELECT
             (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS keys,
             (SELECT COUNT(DISTINCT journal_transaction_id)::text FROM ledger_entries
               WHERE journal_transaction_id IN
                 (SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS journals,
             (SELECT COALESCE(SUM(amount_minor), 0)::text FROM ledger_entries
               WHERE account_id = $2 AND direction = 'CREDIT'
                 AND journal_transaction_id IN
                   (SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS credited`,
          [key, accountY],
        );
        expect(rows[0]).toEqual({ keys: "1", journals: "1", credited: "750" });
      } finally {
        await closeIndependent(check);
      }
    } finally {
      await closeIndependent(conn);
    }
  }, 40_000);

  it("CON-002: many opposite-direction transfers — no deadlock surfaces, totals exact", async () => {
    // P8.6: A→B and B→A racing on independent connections. Ascending-id
    // locking makes a cycle impossible; row-9 retry is the second belt.
    const transfers = 12;
    const mkConn = async (from: bigint, to: bigint, i: number) => {
      const conn = await independentConnection(appConnectionString());
      try {
        return await runMoneyCommand(conn, {
          operation: "TRANSFER",
          idempotencyKey: `con2_${i}_${randomBytes(3).toString("hex")}`,
          requestHash: canonicalHash({ op: "TRANSFER", from: from.toString(), to: to.toString(), i: String(i) }),
          actorId: holderId,
          sessionId: holderSessionId,
          sourceAccountId: from,
          destinationAccountId: to,
          amount: 10n,
          currencyCode: "INR",
        });
      } finally {
        await closeIndependent(conn);
      }
    };
    // Both directions need TRANSFER on the source; grant it on accountY too.
    const grantConn = await independentConnection(appConnectionString());
    try {
      await grantConn.query(
        `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
         VALUES ($1, $2, 'TRANSFER', $1)`,
        [holderId, accountY],
      );
    } finally {
      await closeIndependent(grantConn);
    }
    // Fund accountY enough for 6 outgoing transfers (setup via admin deposit).
    const fund = await independentConnection(appConnectionString());
    try {
      await runMoneyCommand(fund, {
        operation: "DEPOSIT",
        idempotencyKey: `con2_fund_${randomBytes(4).toString("hex")}`,
        requestHash: canonicalHash({ op: "DEPOSIT", seed: randomBytes(4).toString("hex") }),
        actorId: adminId,
        sessionId: adminSessionId,
        destinationAccountId: accountY,
        amount: 100n,
        currencyCode: "INR",
      });
    } finally {
      await closeIndependent(fund);
    }

    const jobs: Array<Promise<{ journalTransactionId: bigint; replayed: boolean }>> = [];
    for (let i = 0; i < transfers; i++) {
      // Alternate directions: even i A→B, odd i B→A.
      jobs.push(i % 2 === 0 ? mkConn(accountX, accountY, i) : mkConn(accountY, accountX, i));
    }
    const results = await Promise.allSettled(jobs);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? "SUCCEEDED" : reasonOf(r.reason)));
    // No deadlock (40P01) or serialization failure may surface to callers.
    expect(outcomes.filter((o) => o === "LOCK_TIMEOUT")).toEqual([]);
    expect(outcomes.filter((o) => o.startsWith("injected") || o.includes("deadlock"))).toEqual([]);
    // Every transfer either succeeded or was legitimately refused for funds.
    for (const o of outcomes) {
      expect(["SUCCEEDED", "INSUFFICIENT_FUNDS"]).toContain(o);
    }
    // Totals: net customer movement is zero per transfer pair; stored balances
    // still equal ledger-derived totals (the real CON-002 assertion).
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ mismatches: string; unbalanced: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM (
              SELECT a.id FROM accounts a
              WHERE a.kind = 'CUSTOMER'
                AND a.balance_minor <> (COALESCE((SELECT SUM(amount_minor) FROM ledger_entries
                     WHERE account_id = a.id AND direction = 'CREDIT'), 0)
                     - COALESCE((SELECT SUM(amount_minor) FROM ledger_entries
                     WHERE account_id = a.id AND direction = 'DEBIT'), 0))
            ) AS m) AS mismatches,
           (SELECT COUNT(*)::text FROM (
              SELECT journal_transaction_id FROM ledger_entries
              GROUP BY journal_transaction_id
              HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'), 0)
                  <> COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'), 0)
            ) AS u) AS unbalanced`,
      );
      expect(rows[0]).toEqual({ mismatches: "0", unbalanced: "0" });
    } finally {
      await closeIndependent(conn);
    }
  }, 60_000);

  it("CON-003: forced serialization/deadlock failure — runner retries transparently with the SAME key, exactly one effect", async () => {
    // P8.7 via the sanctioned fault-injection hook: the first execution
    // attempt fails with a synthetic 40P01; the row-9 retry re-runs the WHOLE
    // command (same key) in a fresh transaction and succeeds.
    const previousEnv = process.env.BV_TEST_FAULT_INJECT;
    process.env.BV_TEST_FAULT_INJECT = "deadlock_once";
    const conn = await independentConnection(appConnectionString());
    const key = `con3_${randomBytes(4).toString("hex")}`;
    const command = () => ({
      operation: "DEPOSIT" as const,
      idempotencyKey: key,
      requestHash: canonicalHash({ op: "DEPOSIT", amount: "125", currency: "INR", key }),
      actorId: adminId,
      sessionId: adminSessionId,
      destinationAccountId: accountY,
      amount: 125n,
      currencyCode: "INR",
    });
    try {
      const result = await runMoneyCommand(conn, command());
      expect(result.replayed).toBe(false);
    } finally {
      if (previousEnv === undefined) delete process.env.BV_TEST_FAULT_INJECT;
      else process.env.BV_TEST_FAULT_INJECT = previousEnv;
      await closeIndependent(conn);
    }
    // Exactly ONE financial effect; and the retried attempt left NO FAILED
    // attempt row (the retry is transparent, not an infrastructure failure).
    const check = await independentConnection(appConnectionString());
    try {
      const { rows } = await check.query<{ keys: string; credited: string; failed: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS keys,
           (SELECT COALESCE(SUM(amount_minor), 0)::text FROM ledger_entries
             WHERE account_id = $2 AND direction = 'CREDIT'
               AND journal_transaction_id IN
                 (SELECT journal_transaction_id FROM idempotency_records WHERE idempotency_key = $1)) AS credited,
           (SELECT COUNT(*)::text FROM transaction_attempts
             WHERE actor_id = $3 AND status = 'FAILED' AND reason_code = 'LOCK_TIMEOUT') AS failed`,
        [key, accountY, adminId],
      );
      expect(rows[0]).toEqual({ keys: "1", credited: "125", failed: "0" });
    } finally {
      await closeIndependent(check);
    }
  }, 40_000);

  it("CON-004: 50 concurrent deposits to different AND same accounts — exact totals, no stall", async () => {
    // P7.9: many deposits in parallel on independent connections. The clearing
    // account is NEVER locked, so there is no global serialisation point.
    const accounts = [accountX, accountY];
    // Distribute 50 deposits round-robin over the two accounts.
    const jobs: Array<{ account: bigint; amount: bigint; index: number }> = [];
    for (let i = 0; i < 50; i++) {
      jobs.push({ account: accounts[i % accounts.length]!, amount: 100n, index: i });
    }
    const started = Date.now();
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        const conn = await independentConnection(appConnectionString());
        try {
          return await runMoneyCommand(conn, {
            operation: "DEPOSIT",
            idempotencyKey: `con4_${job.index}_${randomBytes(3).toString("hex")}`,
            requestHash: canonicalHash({ op: "DEPOSIT", i: String(job.index) }),
            actorId: adminId,
            sessionId: adminSessionId,
            destinationAccountId: job.account,
            amount: job.amount,
            currencyCode: "INR",
          });
        } finally {
          await closeIndependent(conn);
        }
      }),
    );
    const elapsed = Date.now() - started;
    const outcomes = results.map((r) => (r.status === "fulfilled" ? "SUCCEEDED" : reasonOf(r.reason)));
    // No stall: every deposit resolved well inside the harness timeouts.
    expect(elapsed).toBeLessThan(35_000);
    // Exact totals: all 50 succeeded; each account credited exactly its share.
    expect(outcomes.filter((o) => o !== "SUCCEEDED")).toEqual([]);
    const expected = new Map<bigint, bigint>();
    for (const job of jobs) {
      expected.set(job.account, (expected.get(job.account) ?? 0n) + job.amount);
    }
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query<{ account_id: string; credited: string }>(
        `SELECT account_id::text AS account_id,
                COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credited
           FROM ledger_entries
          WHERE journal_transaction_id IN (
            SELECT journal_transaction_id FROM idempotency_records
             WHERE idempotency_key LIKE 'con4_%' AND operation = 'DEPOSIT'
               AND response_status = 200)
          GROUP BY account_id`,
      );
      const credited = new Map(rows.map((r) => [BigInt(r.account_id), BigInt(r.credited)]));
      for (const [account, total] of expected) {
        expect(credited.get(account) ?? 0n).toBe(total);
      }
    } finally {
      await closeIndependent(conn);
    }
  }, 60_000);

  it("INV-001: assertGlobalInvariants reports zero violations over the authoritative ledger", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      const report = await assertGlobalInvariants(conn);
      expect(report.journalsChecked).toBeGreaterThan(0);
      expect(report.accountsChecked).toBeGreaterThan(0);
      expect(report.violations).toEqual([]);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("FIN-002: injected abort between debit and credit — whole transaction rolls back, key not consumed", async () => {
    // P8.5: the classic crash mid-transfer. The sanctioned hook aborts after
    // the FIRST posting; the retry wrapper must roll back EVERYTHING (journal,
    // entries, balance bumps, seq allocation, idempotency claim) and surface
    // the failure — with the key still usable for a legitimate retry.
    const before = await independentConnection(appConnectionString());
    let xBefore: string;
    let yBefore: string;
    try {
      const { rows } = await before.query<{ x: string; y: string }>(
        `SELECT
           (SELECT balance_minor::text FROM accounts WHERE id = $1) AS x,
           (SELECT balance_minor::text FROM accounts WHERE id = $2) AS y`,
        [accountX, accountY],
      );
      xBefore = rows[0]!.x;
      yBefore = rows[0]!.y;
    } finally {
      await closeIndependent(before);
    }

    const previousEnv = process.env.BV_TEST_FAULT_INJECT;
    process.env.BV_TEST_FAULT_INJECT = "abort_mid_transfer";
    const key = `fin2_${randomBytes(4).toString("hex")}`;
    const command = () => ({
      operation: "TRANSFER" as const,
      idempotencyKey: key,
      requestHash: canonicalHash({ op: "TRANSFER", key }),
      actorId: holderId,
      sessionId: holderSessionId,
      sourceAccountId: accountX,
      destinationAccountId: accountY,
      amount: 777n,
      currencyCode: "INR",
    });
    let failure: unknown = null;
    const failedAt = new Date();
    const conn = await independentConnection(appConnectionString());
    try {
      try {
        await runMoneyCommand(conn, command());
      } catch (error) {
        failure = error;
      }
    } finally {
      if (previousEnv === undefined) delete process.env.BV_TEST_FAULT_INJECT;
      else process.env.BV_TEST_FAULT_INJECT = previousEnv;
      await closeIndependent(conn);
    }
    expect(failure).not.toBeNull();

    // Post-mortem: NOTHING durable happened, and the infrastructure failure
    // left exactly one best-effort FAILED attempt row (D-9).
    const check = await independentConnection(appConnectionString());
    try {
      const { rows } = await check.query<{
        keys: string;
        journals: string;
        x: string;
        y: string;
        failed: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM idempotency_records WHERE idempotency_key = $1) AS keys,
           (SELECT COUNT(*)::text FROM ledger_entries le
             JOIN idempotency_records ir ON ir.journal_transaction_id = le.journal_transaction_id
            WHERE ir.idempotency_key = $1) AS journals,
           (SELECT balance_minor::text FROM accounts WHERE id = $2) AS x,
           (SELECT balance_minor::text FROM accounts WHERE id = $3) AS y,
           (SELECT COUNT(*)::text FROM transaction_attempts
             WHERE actor_id = $4 AND status = 'FAILED' AND reason_code = 'INFRA_FAILURE'
               AND created_at > $5) AS failed`,
        [key, accountX, accountY, holderId, failedAt.toISOString()],
      );
      // Key NOT consumed, no partial journal, balances untouched, one D-9 row.
      expect(rows[0]).toEqual({ keys: "0", journals: "0", x: xBefore, y: yBefore, failed: "1" });
    } finally {
      await closeIndependent(check);
    }

    // Correct idempotency behavior after an infrastructure failure: the SAME
    // key performs the real work (row 8/9 — not consumed, retry-safe), and a
    // third execution then replays the stored success (row 10).
    const retryConn = await independentConnection(appConnectionString());
    try {
      const retry = await runMoneyCommand(retryConn, command());
      expect(retry.replayed).toBe(false);
      const replay = await runMoneyCommand(retryConn, command());
      expect(replay.replayed).toBe(true);
      expect(replay.journalTransactionId).toBe(retry.journalTransactionId);
    } finally {
      await closeIndependent(retryConn);
    }
    // Global invariants still hold after the aborted attempt.
    const inv = await independentConnection(appConnectionString());
    try {
      expect((await assertGlobalInvariants(inv)).violations).toEqual([]);
    } finally {
      await closeIndependent(inv);
    }
  }, 40_000);

  it("AUTH-008 (order 1): session revocation forced over an in-flight transfer — revocation WAITS for the commit", async () => {
    // The transfer parks inside the sanctioned post-first-lock pause while
    // holding the session row FOR SHARE (D-8 step 1). The revocation UPDATE
    // launched mid-flight can only commit AFTER the transfer commits: had it
    // landed first, the step-1 session read would have refused the transfer.
    // A successful transfer + a successful revocation therefore PROVE the
    // "operation that already authorised may finish" order (ADR-007).
    const previousPause = process.env.BV_TEST_LOCK_PAUSE_MS;
    process.env.BV_TEST_LOCK_PAUSE_MS = "800";
    const key = `auth8a_${randomBytes(4).toString("hex")}`;
    const transferPromise = (async () => {
      const conn = await independentConnection(appConnectionString());
      try {
        return await runMoneyCommand(conn, {
          operation: "TRANSFER",
          idempotencyKey: key,
          requestHash: canonicalHash({ op: "TRANSFER", key }),
          actorId: holderId,
          sessionId: holderSessionId,
          sourceAccountId: accountX,
          destinationAccountId: accountY,
          amount: 55n,
          currencyCode: "INR",
        });
      } finally {
        await closeIndependent(conn);
      }
    })();
    let revoked = false;
    const revokePromise = (async () => {
      // Park until the transfer is inside its pause window.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const conn = await independentConnection(appConnectionString());
      try {
        const { rowCount } = await conn.query(
          "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
          [holderSessionId],
        );
        revoked = rowCount === 1;
      } finally {
        await closeIndependent(conn);
      }
    })();
    let transfer: { journalTransactionId: bigint; replayed: boolean } | null = null;
    try {
      [transfer] = await Promise.all([transferPromise, revokePromise]);
    } finally {
      if (previousPause === undefined) delete process.env.BV_TEST_LOCK_PAUSE_MS;
      else process.env.BV_TEST_LOCK_PAUSE_MS = previousPause;
    }
    expect(transfer).not.toBeNull();
    expect(transfer!.replayed).toBe(false);
    expect(revoked).toBe(true);
  }, 40_000);

  it("AUTH-008 (order 2): a transfer started AFTER the session revocation committed is refused", async () => {
    // holderSessionId was revoked by the order-1 test; D-8 step 1 (single
    // active-session predicate under FOR SHARE) refuses with UNAUTHENTICATED
    // and the replay gate never gets near the stored result.
    const conn = await independentConnection(appConnectionString());
    try {
      await expect(
        runMoneyCommand(conn, {
          operation: "TRANSFER",
          idempotencyKey: `auth8b_${randomBytes(4).toString("hex")}`,
          requestHash: canonicalHash({ op: "TRANSFER", after: "revocation" }),
          actorId: holderId,
          sessionId: holderSessionId,
          sourceAccountId: accountX,
          destinationAccountId: accountY,
          amount: 5n,
          currencyCode: "INR",
        }),
      ).rejects.toThrow(/UNAUTHENTICATED/);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("AUTH-008 (grant): grant revocation forced over an in-flight transfer waits; a fresh transfer after revocation is refused with one D-9 row", async () => {
    // Fresh session (the original was revoked above), then the same forced
    // overlap against the GRANT row's FOR SHARE: the revocation UPDATE blocks
    // until the already-authorised transfer commits (ADR-007).
    const conn = await independentConnection(appConnectionString());
    let holderSession2 = 0n;
    try {
      const { rows: sess } = await conn.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour') RETURNING id::text AS id`,
        [holderId, `race-token-${randomBytes(8).toString("hex")}`],
      );
      holderSession2 = BigInt(sess[0]!.id);
    } finally {
      await closeIndependent(conn);
    }
    const previousPause = process.env.BV_TEST_LOCK_PAUSE_MS;
    process.env.BV_TEST_LOCK_PAUSE_MS = "800";
    const key = `auth8c_${randomBytes(4).toString("hex")}`;
    const transferPromise = (async () => {
      const c = await independentConnection(appConnectionString());
      try {
        return await runMoneyCommand(c, {
          operation: "TRANSFER",
          idempotencyKey: key,
          requestHash: canonicalHash({ op: "TRANSFER", key }),
          actorId: holderId,
          sessionId: holderSession2,
          sourceAccountId: accountX,
          destinationAccountId: accountY,
          amount: 15n,
          currencyCode: "INR",
        });
      } finally {
        await closeIndependent(c);
      }
    })();
    const revokePromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const c = await independentConnection(appConnectionString());
      try {
        await c.query(
          `UPDATE account_permissions SET revoked_at = now()
            WHERE user_id = $1 AND account_id = $2 AND permission = 'TRANSFER' AND revoked_at IS NULL`,
          [holderId, accountX],
        );
      } finally {
        await closeIndependent(c);
      }
    })();
    let transfer: { journalTransactionId: bigint; replayed: boolean } | null = null;
    try {
      [transfer] = await Promise.all([transferPromise, revokePromise]);
    } finally {
      if (previousPause === undefined) delete process.env.BV_TEST_LOCK_PAUSE_MS;
      else process.env.BV_TEST_LOCK_PAUSE_MS = previousPause;
    }
    expect(transfer).not.toBeNull();
    expect(transfer!.replayed).toBe(false);

    // A transfer started after the grant revocation committed is refused at
    // the pre-claim site: uniform ACCOUNT_NOT_FOUND envelope plus exactly one
    // D-9 authorisation-refusal attempt row (internal truth FORBIDDEN).
    const refusedAt = new Date();
    const fresh = await independentConnection(appConnectionString());
    try {
      await expect(
        runMoneyCommand(fresh, {
          operation: "TRANSFER",
          idempotencyKey: `auth8d_${randomBytes(4).toString("hex")}`,
          requestHash: canonicalHash({ op: "TRANSFER", after: "grant-revocation" }),
          actorId: holderId,
          sessionId: holderSession2,
          sourceAccountId: accountX,
          destinationAccountId: accountY,
          amount: 5n,
          currencyCode: "INR",
        }),
      ).rejects.toThrow(/ACCOUNT_NOT_FOUND/);
    } finally {
      await closeIndependent(fresh);
    }
    const check = await independentConnection(appConnectionString());
    try {
      const { rows } = await check.query<{ d9: string }>(
        `SELECT COUNT(*)::text AS d9 FROM transaction_attempts
          WHERE actor_id = $1 AND status = 'REFUSED'
            AND created_at > $2 AND account_event_seq IS NULL`,
        [holderId, refusedAt.toISOString()],
      );
      expect(rows[0]!.d9).toBe("1");
    } finally {
      await closeIndependent(check);
    }
  }, 40_000);
});

/** Extract the refusal code from a rejected runner promise (DomainError). */
function reasonOf(reason: unknown): string {
  if (reason instanceof DomainError) return reason.code;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
