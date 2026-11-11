/**
 * Global invariant assertion (PHASE-06 P6.7; ACCEPTANCE.md INV-001).
 *
 * Read-only diagnostic over the authoritative ledger — takes NO row locks and
 * runs on any client (runtime role included); it never mutates financial
 * records. Reusable by integration/concurrency tests (INV-001) and by the
 * Phase 10 reconciliation surfaces.
 *
 * Assertions, per the approved invariant:
 *   1. Every journal is balanced: debits = credits and >= 2 entries
 *      (double-enforced at COMMIT by the deferred triggers; asserted here).
 *   2. Per CUSTOMER account, the stored cached balance equals the
 *      ledger-derived total (Σcredits − Σdebits over `ledger_entries`).
 *   3. Over the SHARED event counter `accounts.event_last_seq`: the union of
 *      allocated values in `ledger_entries.account_event_seq` and
 *      locked-REFUSED `transaction_attempts.account_event_seq` is gap-free and
 *      equals exactly 1..event_last_seq (proved by count = N ∧ sum = N(N+1)/2
 *      over distinct positive values). `global_seq` is deliberately
 *      non-gap-free and is excluded.
 *   4. No stored balance is negative (belt-and-braces; the CHECK also guards).
 *
 * Reconciliation DISCREPANCIES are REPORTED, never corrected: corrections go
 * through the compensating-journal path (API_CONTRACT §Account lifecycle),
 * never through direct mutation.
 */

import type { PoolClient } from "pg";

export type InvariantReport = {
  accountsChecked: number;
  journalsChecked: number;
  /** Human-readable violation lines; empty means all invariants hold. */
  violations: string[];
};

export async function assertGlobalInvariants(
  client: PoolClient,
  violationLimit = 20,
): Promise<InvariantReport> {
  const violations: string[] = [];

  // 1. Journal balance (unbalanced or under-posted journals).
  const unbalanced = await client.query<{ journal_id: string; debit: string; credit: string; entries: string }>(
    `SELECT journal_transaction_id::text AS journal_id,
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debit,
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credit,
            COUNT(*)::text AS entries
       FROM ledger_entries
      GROUP BY journal_transaction_id
     HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)
         <> COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
         OR COUNT(*) < 2
      LIMIT $1`,
    [violationLimit],
  );
  for (const row of unbalanced.rows) {
    violations.push(
      `unbalanced journal ${row.journal_id}: debits ${row.debit} <> credits ${row.credit} (${row.entries} entries)`,
    );
  }
  const { rows: journalCountRows } = await client.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM journal_transactions",
  );
  const journalsChecked = Number(journalCountRows[0]?.n ?? 0);

  // 2+3+4. Per-account reconciliation over customer accounts. Each aggregate
  // is computed in its own subquery BEFORE joining, so no join fan-out can
  // multiply sums (a cross join of entries × allocated rows would otherwise
  // inflate both the derived balance and the seq sum).
  const accounts = await client.query<{
    account_id: string;
    kind: string;
    stored: string | null;
    derived: string;
    event_last_seq: string | null;
    seq_count: string;
    seq_sum: string | null;
  }>(
    `WITH ledger_agg AS (
       SELECT account_id,
              COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
                - COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) AS derived
         FROM ledger_entries GROUP BY account_id
     ), allocated AS (
       SELECT account_id, account_event_seq AS seq FROM ledger_entries
        WHERE account_event_seq IS NOT NULL
       UNION ALL
       SELECT account_id, account_event_seq FROM transaction_attempts
        WHERE account_event_seq IS NOT NULL AND status = 'REFUSED'
     ), seq_agg AS (
       SELECT account_id, COUNT(DISTINCT seq) AS seq_count, COALESCE(SUM(seq), 0) AS seq_sum
         FROM allocated GROUP BY account_id
     )
     SELECT a.id::text AS account_id, a.kind,
            a.balance_minor::text AS stored,
            COALESCE(la.derived, 0)::text AS derived,
            a.event_last_seq::text AS event_last_seq,
            COALESCE(sa.seq_count, 0)::text AS seq_count,
            COALESCE(sa.seq_sum, 0)::text AS seq_sum
       FROM accounts a
       LEFT JOIN ledger_agg la ON la.account_id = a.id
       LEFT JOIN seq_agg sa ON sa.account_id = a.id
      WHERE a.kind = 'CUSTOMER'
      ORDER BY a.id`,
  );

  for (const row of accounts.rows) {
    const stored = row.stored === null ? null : BigInt(row.stored);
    const derived = BigInt(row.derived);
    if (stored !== null && stored !== derived) {
      violations.push(
        `account ${row.account_id}: stored balance ${stored} <> ledger-derived ${derived}`,
      );
    }
    if (stored !== null && stored < 0n) {
      violations.push(`account ${row.account_id}: negative stored balance ${stored}`);
    }
    const lastSeq = row.event_last_seq === null ? 0n : BigInt(row.event_last_seq);
    const distinctCount = BigInt(row.seq_count);
    const seqSum = row.seq_sum === null ? 0n : BigInt(row.seq_sum);
    // Gap-free proof: distinct allocated values count to N and sum to N(N+1)/2.
    const expectedSum = (lastSeq * (lastSeq + 1n)) / 2n;
    if (distinctCount !== lastSeq || seqSum !== expectedSum) {
      violations.push(
        `account ${row.account_id}: event sequence not gap-free 1..${lastSeq} ` +
          `(distinct ${distinctCount}, sum ${seqSum}, expected sum ${expectedSum})`,
      );
    }
  }

  return { accountsChecked: accounts.rows.length, journalsChecked, violations };
}
