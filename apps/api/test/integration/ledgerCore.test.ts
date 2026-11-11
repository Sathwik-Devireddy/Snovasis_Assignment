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
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1",
        [`race_%_${seedSuffix}@test.local`],
      );
    } finally {
      await closeIndependent(conn);
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
});

/** Extract the refusal code from a rejected runner promise (DomainError). */
function reasonOf(reason: unknown): string {
  if (reason instanceof DomainError) return reason.code;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
