import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  decodeCursor,
  encodeCursor,
  mergeTimeline,
  type RawAttemptRow,
  type RawEventRow,
  type StatementCursor,
} from "../../domain/statement.js";
import { buildAuthenticate, type SessionDeps } from "../../auth/session.js";
import { DomainError } from "../errors.js";
import { isInt64Token } from "../../domain/money.js";

/**
 * GET /accounts/:accountId/statement — merged timeline (PHASE-10 P10.1;
 * REFUSAL_CODES §5/§6, decision 9).
 *
 * Access (P10.2): ADMIN or AUDITOR see any account; ACCOUNT_HOLDER needs an
 * active VIEW grant; anyone else — including a nonexistent account — receives
 * the single uniform 404 `ACCOUNT_NOT_FOUND` envelope (§0 two-sided truth;
 * AUTH-009 discipline).
 *
 * Never in a statement (any viewer): `account_status_detail` (ASD-001 — it is
 * audit-view content only), FAILED attempt rows (infra failures are audit-view
 * content), SUCCEEDED attempt rows (they would duplicate postings), and no
 * request payloads. Reason codes stay granular for entitled viewers (A8).
 * Money/sequence values are serialised as strings (T-049).
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AccountHeaderRow = {
  id: string;
  account_number: string;
  label: string;
  currency_code: string;
  kind: string;
  status: string;
  balance_minor: string | null;
  event_last_seq: string | null;
};

type EventSqlRow = {
  seq: string;
  row_kind: string;
  type: string;
  direction: string | null;
  amount_minor: string | null;
  balance_after: string | null;
  occurred_at: Date;
  initiated_by: string | null;
  journal_id: string | null;
  initiator_email: string | null;
  reason_code: string | null;
};

type AttemptSqlRow = {
  global_seq: string;
  occurred_at: Date;
  reason_code: string;
  operation: string;
  initiated_by: string | null;
  initiator_email: string | null;
};

export function registerStatementRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; sessions: SessionDeps },
) {
  const authenticate = buildAuthenticate(deps.sessions);
  app.get(
    "/accounts/:accountId/statement",
    { preHandler: [authenticate] },
    async (request, reply) => {
    const actor = request.actor;
    if (!actor) throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED");
    const rawId = (request.params as { accountId: string }).accountId;
    if (!isInt64Token(rawId)) {
      // Non-numeric ids get the SAME uniform envelope as nonexistent accounts.
      // master-stabilisation 5.3: 19-digit tokens above INT64_MAX are rejected
      // here too, before they can reach PostgreSQL as bigint params (22003).
      throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
    }
    const accountId = BigInt(rawId);

    // Pagination parameters: limit clamped; cursor opaque.
    const query = request.query as { limit?: string; cursor?: string };
    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      if (!/^\d{1,4}$/.test(query.limit)) {
        throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED");
      }
      limit = Math.min(Math.max(Number(query.limit), 1), MAX_LIMIT);
    }
    let cursor: StatementCursor;
    try {
      cursor = decodeCursor(query.cursor);
    } catch {
      throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED", "CURSOR_MALFORMED");
    }

    const client = await deps.pgPool.connect();
    try {
      // Header + access in ONE statement: the viewer must be ADMIN/AUDITOR or
      // hold an active VIEW grant; otherwise the account "does not exist".
      const { rows: headerRows } = await client.query<AccountHeaderRow>(
        `SELECT a.id::text AS id, a.account_number, a.label, a.currency_code, a.kind, a.status,
                a.balance_minor::text AS balance_minor, a.event_last_seq::text AS event_last_seq
           FROM accounts a
          WHERE a.id = $1
            AND ($2 = 'ADMIN' OR $2 = 'AUDITOR' OR EXISTS (
              SELECT 1 FROM account_permissions p
               WHERE p.user_id = $3 AND p.account_id = a.id
                 AND p.revoked_at IS NULL AND p.permission = 'VIEW'))`,
        [accountId, actor.role, BigInt(actor.id)],
      );
      if (headerRows.length === 0) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
      }
      const header = headerRows[0]!;

      // Category A: postings + locked refusals, one shared counter namespace,
      // strictly `account_event_seq` ascending; keyset on the counter.
      const { rows: eventRows } = await client.query<EventSqlRow>(
        `SELECT ev.seq::text AS seq, ev.row_kind, ev.type, ev.direction,
                ev.amount_minor::text AS amount_minor, ev.balance_after::text AS balance_after,
                ev.occurred_at, ev.initiated_by::text AS initiated_by, ev.journal_id::text AS journal_id,
                ev.reason_code, u.email AS initiator_email
           FROM (
             SELECT le.account_event_seq AS seq, 'posting' AS row_kind, jt.type, le.direction,
                    le.amount_minor, le.balance_after_minor AS balance_after,
                    le.created_at AS occurred_at, jt.initiated_by,
                    le.journal_transaction_id AS journal_id, NULL AS reason_code
               FROM ledger_entries le
               JOIN journal_transactions jt ON jt.id = le.journal_transaction_id
              WHERE le.account_id = $1
             UNION ALL
             SELECT ta.account_event_seq, 'refusal', 'REFUSAL', NULL, NULL,
                    ta.balance_at_attempt_minor, ta.created_at, ta.actor_id, NULL, ta.reason_code
               FROM transaction_attempts ta
              WHERE ta.account_id = $1
                AND ta.status = 'REFUSED'
                AND ta.account_event_seq IS NOT NULL
           ) ev
           LEFT JOIN users u ON u.id = ev.initiated_by
          WHERE ($2::bigint IS NULL OR ev.seq > $2::bigint)
          ORDER BY ev.seq ASC
          LIMIT $3`,
        [accountId, cursor.e, limit + 1],
      );

      // Category B: unsequenced refusals, `(occurred_at, global_seq)` ascending;
      // FAILED rows never qualify (infra failures are audit-view content only).
      const { rows: attemptRows } = await client.query<AttemptSqlRow>(
        `SELECT ta.global_seq::text AS global_seq, ta.created_at AS occurred_at,
                ta.reason_code, ta.operation, ta.actor_id::text AS initiated_by,
                u.email AS initiator_email
           FROM transaction_attempts ta
           LEFT JOIN users u ON u.id = ta.actor_id
          WHERE ta.account_id = $1
            AND ta.status = 'REFUSED'
            AND ta.account_event_seq IS NULL
            AND ($2::timestamptz IS NULL
                 OR (ta.created_at, ta.global_seq) > ($2::timestamptz, $3::bigint))
          ORDER BY ta.created_at ASC, ta.global_seq ASC
          LIMIT $4`,
        [accountId, cursor.a === null ? null : cursor.a[0], cursor.a === null ? null : cursor.a[1], limit + 1],
      );

      const events: RawEventRow[] = eventRows.map((r) => ({
        seq: r.seq,
        rowKind: r.row_kind === "refusal" ? "refusal" : "posting",
        type: r.type,
        direction: r.direction,
        amountMinor: r.amount_minor,
        balance: r.balance_after,
        occurredAt: new Date(r.occurred_at),
        initiatedBy: r.initiated_by,
        journalId: r.journal_id,
        initiatorEmail: r.initiator_email,
        reasonCode: r.reason_code,
      }));
      const attempts: RawAttemptRow[] = attemptRows.map((r) => ({
        globalSeq: r.global_seq,
        occurredAt: new Date(r.occurred_at),
        reasonCode: r.reason_code,
        operation: r.operation,
        initiatedBy: r.initiated_by,
        initiatorEmail: r.initiator_email,
      }));

      const merged = mergeTimeline(events, attempts, limit);
      // Cursor continuation: carry forward the last EMITTED position of each
      // category; a category that emitted nothing keeps its incoming cursor
      // (it is exhausted past that point — never restart, never duplicate).
      const nextE = merged.lastEvent !== null ? merged.lastEvent.seq : cursor.e;
      const nextA: [string, string] | null =
        merged.lastAttempt !== null
          ? [merged.lastAttempt.occurredAt.toISOString(), merged.lastAttempt.globalSeq]
          : cursor.a;
      const nextCursor = merged.hasMore ? encodeCursor({ e: nextE, a: nextA }) : null;

      return await reply.code(200).send({
        account: {
          id: header.id,
          accountNumber: header.account_number,
          label: header.label,
          currencyCode: header.currency_code,
          kind: header.kind,
          status: header.status,
          balanceMinor: header.balance_minor,
          eventLastSeq: header.event_last_seq,
        },
        timeline: merged.rows,
        nextCursor,
      });
    } finally {
      client.release();
    }
  });
}
