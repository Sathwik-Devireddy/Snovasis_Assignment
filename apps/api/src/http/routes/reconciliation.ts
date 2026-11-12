import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildAuthenticate, type SessionDeps } from "../../auth/session.js";
import { DomainError } from "../errors.js";
import { isInt64Token } from "../../domain/money.js";
import { assertGlobalInvariants, type InvariantReport } from "../../domain/invariants.js";

/**
 * GET /reconciliation/accounts/:accountId  — per-account stored vs ledger-derived
 * GET /reconciliation/summary             — global conservation totals
 *
 * PHASE-10 P10.4. Reuses `assertGlobalInvariants` (read-only diagnostic that
 * never mutates balances or journals). Both endpoints are read-only.
 *
 * Access (AUTHZ_MATRIX §B): ADMIN or AUDITOR see reconciliation; any other
 * actor — including holders — receives the single uniform 404
 * `ACCOUNT_NOT_FOUND` envelope (deny-by-default).
 *
 * Money values serialised as strings (T-049). `account_status_detail` is never
 * returned (audit-view content only).
 */

export function registerReconciliationRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; sessions: SessionDeps },
) {
  const authenticate = buildAuthenticate(deps.sessions);

  // ---- GET /reconciliation/accounts/:accountId -----------------------------
  app.get(
    "/reconciliation/accounts/:accountId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const actor = (request as { actor: { id: string; role: string } }).actor;
      if (!actor || (actor.role !== "ADMIN" && actor.role !== "AUDITOR")) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Account not found.");
      }
      const rawId = (request.params as { accountId: string }).accountId;
      if (!isInt64Token(rawId)) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Account not found.");
      }
      const accountId = BigInt(rawId);

      const client = await deps.pgPool.connect();
      try {
        // Header: account must exist; ADMIN/AUDITOR see any account (role-level
        // visibility — holders are not permitted to view reconciliation).
        const { rows: headerRows } = await client.query<{
          id: string;
          account_number: string;
          kind: string;
          status: string;
          balance_minor: string | null;
        }>(
          `SELECT a.id::text AS id, a.account_number, a.kind, a.status,
                  a.balance_minor::text AS balance_minor
             FROM accounts a
            WHERE a.id = $1
              AND ($2 = 'ADMIN' OR $2 = 'AUDITOR')`,
          [accountId, actor.role],
        );
        if (headerRows.length === 0) {
          throw new DomainError("ACCOUNT_NOT_FOUND", "Account not found.");
        }
        const header = headerRows[0]!;

        // Ledger-derived balance for this account (Σ credits − Σ debits),
        // entry count, journal count, and allocated event positions — the same
        // aggregates `assertGlobalInvariants` computes, scoped to one account.
        const { rows: aggRows } = await client.query<{
          stored: string | null;
          derived: string;
          entries: string;
          journals: string;
          seq_count: string | null;
          seq_sum: string | null;
          event_last_seq: string | null;
        }>(
          `WITH ledger_agg AS (
             SELECT account_id,
                    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
                  - COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)
                      AS derived,
                    COUNT(*)::text AS entries
               FROM ledger_entries
              WHERE account_id = $1
              GROUP BY account_id
           ), allocated AS (
             SELECT account_event_seq AS seq FROM ledger_entries
              WHERE account_id = $1 AND account_event_seq IS NOT NULL
             UNION ALL
             SELECT account_event_seq FROM transaction_attempts
              WHERE account_id = $1 AND account_event_seq IS NOT NULL
                AND status = 'REFUSED'
           ), seq_agg AS (
             SELECT COUNT(DISTINCT seq) AS seq_count, COALESCE(SUM(seq), 0) AS seq_sum
               FROM allocated
           )
          SELECT a.balance_minor::text AS stored,
                 COALESCE(la.derived, 0)::text AS derived,
                 COALESCE(la.entries, '0')::text AS entries,
                 (SELECT COUNT(*)::text FROM journal_transactions jt
                   JOIN ledger_entries le ON le.journal_transaction_id = jt.id
                  WHERE le.account_id = $1) AS journals,
                 sa.seq_count, sa.seq_sum,
                 a.event_last_seq::text AS event_last_seq
            FROM accounts a
            LEFT JOIN ledger_agg la ON la.account_id = a.id
            LEFT JOIN seq_agg sa ON true
           WHERE a.id = $1`,
          [accountId],
        );
        const agg = aggRows[0]!;

        const stored = agg.stored === null ? null : BigInt(agg.stored);
        const derived = BigInt(agg.derived);
        const eventLastSeq = agg.event_last_seq === null ? 0n : BigInt(agg.event_last_seq);
        const seqCount = BigInt(agg.seq_count ?? "0");
        const seqSum = BigInt(agg.seq_sum ?? "0");
        const expectedSum = (eventLastSeq * (eventLastSeq + 1n)) / 2n;

        // SYSTEM accounts carry no cached balance by design (P6.2) — there is
        // no stored figure that could diverge; the ledger-derived position is
        // the authority. Only CUSTOMER accounts have a stored-vs-derived
        // reconciliation to perform.
        const balanceReconciled =
          header.kind === "SYSTEM" ? true : stored !== null && stored === derived;
        const sequenceReconciled = seqCount === eventLastSeq && seqSum === expectedSum;

        return await reply.code(200).send({
          account: {
            id: header.id,
            accountNumber: header.account_number,
            kind: header.kind,
            status: header.status,
          },
          storedBalance: agg.stored,
          derivedBalance: agg.derived,
          reconciled: balanceReconciled && sequenceReconciled,
          balanceReconciled,
          sequenceReconciled,
          entriesCount: Number(agg.entries),
          journalCount: Number(agg.journals),
          eventLastSeq: agg.event_last_seq,
          allocatedEventCount: agg.seq_count,
          allocatedEventSum: agg.seq_sum,
        });
      } finally {
        client.release();
      }
    },
  );

  // ---- GET /reconciliation/summary -----------------------------------------
  app.get(
    "/reconciliation/summary",
    { preHandler: [authenticate] },
    async (_request, reply) => {
      const actor = (_request as { actor: { id: string; role: string } }).actor;
      if (!actor || (actor.role !== "ADMIN" && actor.role !== "AUDITOR")) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Account not found.");
      }
      // Reuse assertGlobalInvariants: read-only, never mutates.
      const client = await deps.pgPool.connect();
      let report: InvariantReport;
      try {
        report = await assertGlobalInvariants(client);
      } finally {
        client.release();
      }

      // Global conservation (AC4.3): Σ customer derived balances + clearing
      // derived balance = 0. Both sides derive from LEDGER ENTRIES
      // (Σcredits − Σdebits), never from cached balances — SYSTEM account
      // cached balances are required to be NULL (P6.2), so a cached-balance
      // sum would always read zero and falsely report non-conservation.
      // Sign convention (credit-normal): deposit debits EXTERNAL_CLEARING and
      // credits the customer; withdrawals credit EXTERNAL_CLEARING; transfers
      // net to zero across customers. Every journal is balanced, so a correct
      // ledger sums to exactly 0 across all accounts.
      const { rows: conservationRows } = await deps.pgPool.query<{
        customer_total: string | null;
        clearing: string | null;
      }>(
        `SELECT
           (SELECT COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor
                                     ELSE -le.amount_minor END), 0)::text
              FROM ledger_entries le
              JOIN accounts a ON a.id = le.account_id
             WHERE a.kind = 'CUSTOMER') AS customer_total,
           (SELECT COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_minor
                                     ELSE -le.amount_minor END), 0)::text
              FROM ledger_entries le
              JOIN accounts a ON a.id = le.account_id
             WHERE a.kind = 'SYSTEM') AS clearing`,
      );
      const conservation = conservationRows[0]!;
      const customerTotal = BigInt(conservation.customer_total ?? "0");
      const clearing = BigInt(conservation.clearing ?? "0");
      const conserved = customerTotal + clearing === 0n;

      return await reply.code(200).send({
        healthy: report.violations.length === 0 && conserved,
        accountsChecked: report.accountsChecked,
        journalsChecked: report.journalsChecked,
        violations: report.violations,
        conservation: {
          customerBalancesTotal: conservation.customer_total,
          clearingBalance: conservation.clearing,
          conserved,
        },
      });
    },
  );
}
