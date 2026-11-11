/**
 * DomainTransactionRunner (PHASE-06 P6.6; ADR-005 data-access strategy,
 * PROPOSED_DEFAULTS D-8/D-9, REFUSAL_CODES §2–§5, IDEMPOTENCY_BEHAVIORS).
 *
 * Every financial operation runs inside ONE explicit raw-pg transaction owned
 * by this runner — never a Prisma transaction, never split across pools
 * (TX-BOUNDARY-001). All locks, checks, writes and attempt rows participate in
 * that single PostgreSQL transaction.
 *
 * Declared lock order (AUTHZ_MATRIX §D.6; CON-002):
 *   1. actor's session row (FOR SHARE)
 *   2. actor's users row (FOR SHARE)
 *   3. grant rows (FOR SHARE, ascending id)
 *   4. idempotency key claim (UNIQUE INSERT — the DB unique row IS the mutex)
 *   5. customer account rows (FOR UPDATE, ascending id; SYSTEM rows never locked)
 * The admin-lifecycle path shares only the `sessions → users` segment, so no
 * lock cycle can form.
 *
 * Canonical phase order (REFUSAL_CODES §2) and refusal classes:
 *   - transport (400/401/429): no attempt row, nothing durable.
 *   - authorisation (internal FORBIDDEN / ACCOUNT_NOT_FOUND): money tx
 *     ROLLS BACK (no key consumed); a separate short D-9 transaction writes
 *     one compact REFUSED attempt row (best-effort — a failed audit insert is
 *     logged and never suppresses the refusal). Externally the single uniform
 *     404 ACCOUNT_NOT_FOUND envelope.
 *   - business (D-8 pre-lock step 3 / under-lock step 5): COMMITTED inside the
 *     money transaction — attempt row(s) REFUSED + the key row stores the
 *     refusal as the replayable outcome. Balance recorded only where the
 *     check ran under lock after a real read; event_seq only under lock.
 *   - infrastructure: everything rolls back (key not consumed); one
 *     best-effort FAILED attempt row in a separate short transaction.
 *
 * Replay gate (D-8 step 2, IDEMPOTENCY_BEHAVIORS row 7): evaluation-only pass
 * in declared lock order — (a) session validity, (b) grants/visibility, (c)
 * involved accounts still ACTIVE (FOR SHARE read). A gate refusal changes
 * nothing stored. A gate pass returns the stored outcome with replayed: true.
 */

import type { PoolClient } from "pg";
import {
  MAX_PER_OPERATION,
  SYSTEM_CURRENCY,
  formatMinor,
  isPositive,
  type Minor,
} from "./money.js";
import {
  buildDepositJournal,
  buildTransferJournal,
  buildWithdrawalJournal,
  type Journal,
} from "./journal.js";
import { DomainError, type ErrorCode } from "../http/errors.js";

export type MoneyOperation = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";

export type MoneyCommand = {
  operation: MoneyOperation;
  idempotencyKey: string; // <= 64 chars, opaque
  requestHash: string; // canonical validated-command hash (hex sha-256)
  actorId: bigint;
  sessionId: bigint; // D-8 step 1 lock target: the authenticated session row
  sourceAccountId?: bigint; // WITHDRAWAL / TRANSFER source
  destinationAccountId?: bigint; // DEPOSIT / TRANSFER destination
  amount: Minor;
  currencyCode: string;
  suppliedSourceRef?: string; // verbatim caller-supplied id (AUTH-009)
  suppliedDestinationRef?: string;
};

export type MoneyResult = {
  journalTransactionId: bigint;
  replayed: boolean;
};

/** Internal refusal truth (transaction_attempts face), with its external face. */
type Refusal = {
  internalReason: string;
  externalCode: ErrorCode; // what the caller receives (uniform 404 where required)
  statusDetail?: "SUSPENDED" | "CLOSED"; // account_status_detail (audit views only)
};

/** Account facts visible WITHOUT a row lock (immutable columns only). */
type AccountMeta = {
  id: bigint;
  kind: "CUSTOMER" | "SYSTEM";
  currencyCode: string;
};

/** Account facts read under the FOR UPDATE lock (mutable state included). */
type LockedAccount = AccountMeta & {
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  balanceMinor: bigint | null; // CUSTOMER only
};

async function rollbackQuietly(tx: PoolClient): Promise<void> {
  try {
    await tx.query("ROLLBACK");
  } catch {
    // connection may already be aborted; the pool will discard it
  }
}

/**
 * T-042 DB-side attempt-write cap (RATE-002's second line, Redis-independent):
 * bounds the per-actor volume of best-effort audit rows (FAILED + D-9
 * authorisation refusals) within a 60-second window. A capped write is skipped
 * with a log line — it never changes the caller's response.
 */
async function t042AllowsAttemptWrite(tx: PoolClient, actorId: bigint): Promise<boolean> {
  const cap = Number(process.env.T042_ATTEMPT_WRITE_CAP ?? 60);
  const { rows } = await tx.query(
    `SELECT COUNT(*)::int AS n FROM transaction_attempts
      WHERE actor_id = $1 AND created_at > now() - interval '60 seconds'`,
    [actorId],
  );
  const count = Number(rows[0]?.n ?? 0);
  if (count >= cap) {
    console.warn(`[transactionRunner] T-042 attempt-write cap reached (${count} rows/60s) — audit row skipped`);
    return false;
  }
  return true;
}

/** Best-effort FAILED attempt row for infrastructure failures (D-9). */
async function persistFailedAttempt(
  tx: PoolClient,
  command: MoneyCommand,
  reason: string,
): Promise<void> {
  try {
    if (!(await t042AllowsAttemptWrite(tx, command.actorId))) return;
    await tx.query("BEGIN");
    await tx.query(
      `INSERT INTO transaction_attempts
         (actor_id, operation, status, reason_code, supplied_account_ref)
       VALUES ($1, $2, 'FAILED', $3, $4)`,
      [command.actorId, command.operation, reason, command.suppliedSourceRef ?? command.suppliedDestinationRef ?? null],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(tx);
    console.warn(
      `[transactionRunner] best-effort FAILED attempt row could not be persisted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** One D-9 authorisation-refusal attempt row (key-state-independent). */
async function persistAuthzRefusal(
  tx: PoolClient,
  command: MoneyCommand,
  refusal: Refusal,
  accountId: bigint | null,
): Promise<void> {
  try {
    if (!(await t042AllowsAttemptWrite(tx, command.actorId))) return;
    await tx.query("BEGIN");
    await tx.query(
      `INSERT INTO transaction_attempts
         (actor_id, operation, status, reason_code, supplied_account_ref, account_id)
       VALUES ($1, $2, 'REFUSED', $3, $4, $5)`,
      [
        command.actorId,
        command.operation,
        refusal.internalReason,
        accountId === command.sourceAccountId
          ? command.suppliedSourceRef ?? null
          : accountId === command.destinationAccountId
            ? command.suppliedDestinationRef ?? null
            : command.suppliedSourceRef ?? command.suppliedDestinationRef ?? null,
        accountId,
      ],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(tx);
    console.warn(
      `[transactionRunner] D-9 authorisation-refusal row could not be persisted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Business refusal: COMMIT attempt row(s) + the replayable refusal outcome on
 * the key row — inside the money transaction (D-8 steps 3 and 5) — then throw
 * the mapped external error. `perAccount` rows exist per involved account.
 */
async function commitBusinessRefusal(
  tx: PoolClient,
  command: MoneyCommand,
  idempotencyRecordId: bigint,
  refusal: Refusal,
  rows: Array<{ accountId: bigint | null; balance: Minor | null; seq: bigint | null }>,
): Promise<never> {
  for (const row of rows) {
    await tx.query(
      `INSERT INTO transaction_attempts
         (actor_id, operation, status, reason_code, supplied_account_ref,
          account_id, balance_at_attempt_minor, account_event_seq, account_status_detail)
       VALUES ($1, $2, 'REFUSED', $3, $4, $5, $6, $7, $8)`,
      [
        command.actorId,
        command.operation,
        refusal.internalReason,
        row.accountId === command.sourceAccountId
          ? command.suppliedSourceRef ?? null
          : row.accountId === command.destinationAccountId
            ? command.suppliedDestinationRef ?? null
            : null,
        row.accountId,
        row.balance,
        row.seq,
        refusal.statusDetail ?? null,
      ],
    );
  }
  await tx.query(
    `UPDATE idempotency_records
        SET response_status = $1, response_body = $2, completed_at = now()
      WHERE id = $3`,
    [409, JSON.stringify({ status: "REFUSED", code: refusal.externalCode }), idempotencyRecordId],
  );
  await tx.query("COMMIT");
  throw new DomainError(refusal.externalCode, refusal.externalCode, refusal.internalReason);
}

/**
 * Row 9 (IDEMPOTENCY_BEHAVIORS; P7.1): 40P01 (deadlock) / 40001 (serialization)
 * are RETRIED TRANSPARENTLY — whole command, same key, claim inside the tx —
 * up to 3 attempts total; only then does the caller see 503 LOCK_TIMEOUT.
 * 55P03/40P02 (lock/statement timeout) are NOT retried: 503 immediately,
 * key not consumed, retry-safe.
 */
const DEADLOCK_RETRY_CODES = new Set(["40P01", "40001"]);
// 55P03/40P02: lock/statement timeouts from the pool's T-035 settings;
// 57014: statement_timeout abort ("canceling statement due to statement
// timeout"). None of these are retried: 503 immediately, key not consumed,
// retry-safe.
const TIMEOUT_CODES = new Set(["55P03", "40P02", "57014"]);
const MAX_TX_ATTEMPTS = 3;

/**
 * Test-only fault injection (P8.7 CON-003, sanctioned by the kit's fault
 * injection pattern): BV_TEST_FAULT_INJECT=deadlock_once makes the FIRST
 * execution attempt on a given connection fail with a synthetic 40P01 so
 * tests can prove the retry is transparent (same key, exactly one financial
 * effect, no FAILED attempt row). Never set in production.
 */
const faultInjectedClients = new WeakSet<PoolClient>();

function injectedDeadlockOnce(tx: PoolClient): Error | null {
  if (process.env.BV_TEST_FAULT_INJECT !== "deadlock_once") return null;
  if (faultInjectedClients.has(tx)) return null;
  faultInjectedClients.add(tx);
  const error = new Error("injected deadlock (BV_TEST_FAULT_INJECT)");
  (error as { code?: string }).code = "40P01";
  return error;
}

export async function runMoneyCommand(
  tx: PoolClient,
  command: MoneyCommand,
): Promise<MoneyResult> {
  for (let attempt = 1; ; attempt += 1) {
    const fault = injectedDeadlockOnce(tx);
    try {
      if (fault !== null) throw fault;
      return await executeMoneyTransaction(tx, command);
    } catch (error) {
      // Returns null only to signal a transparent retry; throws otherwise.
      await handleMoneyCommandError(tx, command, error, attempt);
    }
  }
}

/**
 * Shared classification for one failed transaction attempt: returns null to
 * signal a TRANSPARENT RETRY (row 9); throws the caller-facing error otherwise.
 */
async function handleMoneyCommandError(
  tx: PoolClient,
  command: MoneyCommand,
  error: unknown,
  attempt: number,
): Promise<null> {
  if (error instanceof DomainError) throw error;
  await rollbackQuietly(tx);
  const pgCode = (error as { code?: string }).code ?? "";
  if (DEADLOCK_RETRY_CODES.has(pgCode) && attempt < MAX_TX_ATTEMPTS) {
    // Row 9: transparent retry — whole command, same key, claim re-run in a
    // fresh transaction. Nothing durable happened (the loser tx rolled back).
    return null;
  }
  const reason =
    DEADLOCK_RETRY_CODES.has(pgCode) || TIMEOUT_CODES.has(pgCode)
      ? "LOCK_TIMEOUT"
      : "INFRA_FAILURE";
  // Row 8/9 (final): everything rolled back, key NOT consumed, retry-safe.
  // The FAILED attempt row is best-effort (D-9) and never suppresses the error.
  await persistFailedAttempt(tx, command, reason);
  if (reason === "LOCK_TIMEOUT") {
    throw new DomainError("LOCK_TIMEOUT", "LOCK_TIMEOUT");
  }
  throw error instanceof Error ? error : new DomainError("INFRA_FAILURE", "INFRA_FAILURE");
}

async function executeMoneyTransaction(
  tx: PoolClient,
  command: MoneyCommand,
): Promise<MoneyResult> {
  await tx.query("BEGIN");
  try {
    // ---- D-8 step 1: authenticate; the session row is the FIRST money-path
    // lock (FOR SHARE) — a concurrently revoked/expired session fails here.
    const { rows: sessionRows } = await tx.query(
      `SELECT id FROM sessions
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
        FOR SHARE`,
      [command.sessionId, command.actorId],
    );
    const { rows: userRows } = await tx.query(
      `SELECT id, role, status FROM users WHERE id = $1 FOR SHARE`,
      [command.actorId],
    );
    const actorRole = userRows.length > 0 ? String(userRows[0].role) : null;
    const actorActive = userRows.length > 0 && String(userRows[0].status) === "ACTIVE";
    if (sessionRows.length === 0 || !actorActive) {
      await rollbackQuietly(tx);
      throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED");
    }

    // ---- D-8 step 1b: authorise. Metadata read (immutable columns, no row
    // lock) decides existence/classification/currency; grants are read FOR
    // SHARE, ascending id, linearised with revocation (ADR-007).
    const metaById = new Map<bigint, AccountMeta>();
    const missing: Array<{ id: bigint; ref?: string }> = [];
    const involved: Array<{ id: bigint; ref?: string; role: "source" | "destination" }> = [];
    if (command.sourceAccountId !== undefined) {
      involved.push({ id: command.sourceAccountId, ref: command.suppliedSourceRef, role: "source" });
    }
    if (command.destinationAccountId !== undefined) {
      involved.push({ id: command.destinationAccountId, ref: command.suppliedDestinationRef, role: "destination" });
    }
    for (const item of involved) {
      const { rows } = await tx.query(
        `SELECT id, kind, currency_code FROM accounts WHERE id = $1`,
        [item.id],
      );
      if (rows.length === 0) {
        missing.push({ id: item.id, ref: item.ref });
        continue;
      }
      metaById.set(BigInt(rows[0].id), {
        id: BigInt(rows[0].id),
        kind: rows[0].kind === "SYSTEM" ? "SYSTEM" : "CUSTOMER",
        currencyCode: String(rows[0].currency_code),
      });
    }
    // Nonexistent target: authorisation-class refusal (uniform 404; key NOT
    // consumed; D-9 row persisted WITHOUT any account reference — AUTH-009).
    if (missing.length > 0) {
      await rollbackQuietly(tx);
      await persistAuthzRefusal(tx, command, { internalReason: "ACCOUNT_NOT_FOUND", externalCode: "ACCOUNT_NOT_FOUND" }, null);
      throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
    }

    // Grants FOR SHARE (ascending id). Role policy (AUTHZ_MATRIX §A/§B):
    //   DEPOSIT     — ADMIN only (H-2, role-level; holders are never granted DEPOSIT in v1)
    //   WITHDRAWAL  — ADMIN role-level, or the holder's WITHDRAW grant on the source
    //   TRANSFER    — explicit TRANSFER grant on the source for EVERY actor,
    //                 admins included (admins may not move money they hold no
    //                 grant on; PROPOSED_DEFAULTS admin prohibited column)
    //   AUDITOR     — never any money authority
    let refusal: Refusal | null = null;
    let refusedAccountId: bigint | null = null;
    // account_id → set of active permissions (an account may hold several).
    const accountGrants = new Map<string, Set<string>>();
    if (actorRole !== "ADMIN") {
      const { rows: grantRows } = await tx.query(
        `SELECT account_id, permission
           FROM account_permissions
          WHERE user_id = $1 AND revoked_at IS NULL
            AND account_id = ANY($2::bigint[])
          ORDER BY id ASC
          FOR SHARE`,
        [command.actorId, involved.map((i) => i.id.toString())],
      );
      for (const row of grantRows) {
        const key = String(row.account_id);
        let set = accountGrants.get(key);
        if (set === undefined) {
          set = new Set<string>();
          accountGrants.set(key, set);
        }
        set.add(String(row.permission));
      }
    }
    const isAccountVisible = (accountId: bigint): boolean =>
      actorRole === "ADMIN" ||
      actorRole === "AUDITOR" ||
      accountGrants.get(accountId.toString())?.has("VIEW") === true;

    if (actorRole === "AUDITOR") {
      refusal = { internalReason: "FORBIDDEN", externalCode: "ACCOUNT_NOT_FOUND" };
    } else if (command.operation === "DEPOSIT" && actorRole !== "ADMIN") {
      refusal = { internalReason: "FORBIDDEN", externalCode: "ACCOUNT_NOT_FOUND" };
    } else if (command.operation === "WITHDRAWAL" && actorRole !== "ADMIN") {
      const src = command.sourceAccountId!;
      if (accountGrants.get(src.toString())?.has("WITHDRAW") !== true) {
        refusal = { internalReason: "FORBIDDEN", externalCode: "ACCOUNT_NOT_FOUND" };
        refusedAccountId = src;
      }
    } else if (command.operation === "TRANSFER") {
      const src = command.sourceAccountId!;
      if (accountGrants.get(src.toString())?.has("TRANSFER") !== true) {
        refusal = { internalReason: "FORBIDDEN", externalCode: "ACCOUNT_NOT_FOUND" };
        refusedAccountId = src;
      }
    }
    if (refusal !== null) {
      await rollbackQuietly(tx);
      await persistAuthzRefusal(tx, command, refusal, refusedAccountId);
      throw new DomainError(refusal.externalCode, refusal.externalCode, refusal.internalReason);
    }

    // ---- D-8 step 2: idempotency claim (DB unique row IS the mutex).
    const claim = async (): Promise<{ winnerId: bigint } | "conflict"> => {
      const { rows: inserted } = await tx.query(
        `INSERT INTO idempotency_records (actor_id, operation, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
         RETURNING id, request_hash`,
        [command.actorId, command.operation, command.idempotencyKey, command.requestHash],
      );
      if (inserted.length > 0) return { winnerId: BigInt(inserted[0].id) };
      return "conflict";
    };

    let claimResult = await claim();
    // Bounded retries: a conflicting claim whose winner rolled back leaves no
    // row behind; re-claiming is then safe (CON-003 style, max 3 attempts).
    for (let i = 0; i < 3 && claimResult === "conflict"; i += 1) {
      const { rows: existing } = await tx.query(
        `SELECT id, request_hash, response_status, response_body, journal_transaction_id
           FROM idempotency_records
          WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [command.actorId, command.operation, command.idempotencyKey],
      );
      if (existing.length === 0) {
        claimResult = await claim();
        continue;
      }
      const row = existing[0];
      if (String(row.request_hash) !== command.requestHash) {
        // Row 5: canonical conflict, decided from the key row alone — no
        // account-status read, no attempt row, nothing stored changes.
        await rollbackQuietly(tx);
        throw new DomainError("KEY_REUSED", "KEY_REUSED");
      }
      // Rows 4/6/7: replay gate — evaluation-only pass in declared lock order.
      // (a) session validity and (b) grants/visibility already enforced above
      // at steps 1/1b, linearised with revocation.
      // (c) involved customer accounts must still be ACTIVE (FOR SHARE read
      // serialises with a concurrent suspension/closure).
      const involvedIds = [...metaById.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const id of involvedIds) {
        const meta = metaById.get(id)!;
        if (meta.kind !== "CUSTOMER") continue;
        const { rows: statusRows } = await tx.query(
          `SELECT id, status FROM accounts WHERE id = $1 FOR SHARE`,
          [id],
        );
        if (statusRows.length === 0) {
          await rollbackQuietly(tx);
          throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
        }
        if (String(statusRows[0].status) !== "ACTIVE") {
          await rollbackQuietly(tx);
          const status = String(statusRows[0].status) as "SUSPENDED" | "CLOSED";
          // Granular for a VISIBLE account; uniform 404 otherwise (§0/§3).
          const visible = isAccountVisible(id);
          throw new DomainError(
            visible ? "ACCOUNT_NOT_ACTIVE" : "ACCOUNT_NOT_FOUND",
            visible ? "ACCOUNT_NOT_ACTIVE" : "ACCOUNT_NOT_FOUND",
            status,
          );
        }
      }
      await tx.query("COMMIT");
      if (row.response_status === null) {
        // Unreachable: a committed row always carries a finalised response
        // (D-8 has no stuck PROCESSING state); treat as a conflict defensively.
        throw new DomainError("KEY_REUSED", "KEY_REUSED");
      }
      if (row.response_status !== 200) {
        const stored = row.response_body as { code?: string };
        const storedCode = (stored?.code ?? "ACCOUNT_NOT_ACTIVE") as ErrorCode;
        throw new DomainError(storedCode, storedCode, "REPLAYED_REFUSAL");
      }
      const stored = row.response_body as { journalTransactionId?: string };
      return {
        journalTransactionId: BigInt(stored?.journalTransactionId ?? row.journal_transaction_id),
        replayed: true,
      };
    }
    if (claimResult === "conflict") {
      await rollbackQuietly(tx);
      throw new DomainError("INFRA_FAILURE", "INFRA_FAILURE", "idempotency claim retries exhausted");
    }
    const idempotencyRecordId = (claimResult as { winnerId: bigint }).winnerId;

    // ---- D-8 step 3: PRE-LOCK semantic checks (canonical order, §2).
    // Decided from the request + caller-visible immutable metadata ONLY —
    // no account row lock, no balance read, counter never bumped.
    const sameAccount =
      command.operation === "TRANSFER" &&
      command.sourceAccountId !== undefined &&
      command.sourceAccountId === command.destinationAccountId;
    const amountInvalid = !isPositive(command.amount) || command.amount > MAX_PER_OPERATION;
    const currencyMismatch =
      command.currencyCode !== SYSTEM_CURRENCY ||
      [...metaById.values()].some((meta) => meta.currencyCode !== command.currencyCode);
    const systemAccount = [...metaById.values()].find((meta) => meta.kind === "SYSTEM");

    if (sameAccount || amountInvalid || currencyMismatch || systemAccount !== undefined) {
      let business: Refusal;
      if (sameAccount) {
        business = { internalReason: "SAME_ACCOUNT", externalCode: "SAME_ACCOUNT" };
      } else if (amountInvalid) {
        business = { internalReason: "INVALID_AMOUNT", externalCode: "INVALID_AMOUNT" };
      } else if (currencyMismatch) {
        business = { internalReason: "CURRENCY_MISMATCH", externalCode: "CURRENCY_MISMATCH" };
      } else {
        // SYSTEM destination/source: granular only for account-visible
        // callers (the ADMIN cash desk); everyone else gets the uniform 404.
        const target = systemAccount!;
        const visible = isAccountVisible(target.id);
        business = visible
          ? { internalReason: "SYSTEM_ACCOUNT_NOT_ALLOWED", externalCode: "SYSTEM_ACCOUNT_NOT_ALLOWED" }
          : { internalReason: "SYSTEM_ACCOUNT_NOT_ALLOWED", externalCode: "ACCOUNT_NOT_FOUND" };
      }
      const rows = [...metaById.values()].map((meta) => ({
        accountId: meta.id as bigint | null,
        balance: null as Minor | null,
        seq: null as bigint | null,
      }));
      await commitBusinessRefusal(tx, command, idempotencyRecordId, business, rows);
    }

    // ---- D-8 step 4: lock the involved CUSTOMER rows, ascending id
    // (SYSTEM accounts are never locked or cached — P6.2).
    const lockedById = new Map<bigint, LockedAccount>();
    const customerIds = [...metaById.values()]
      .filter((meta) => meta.kind === "CUSTOMER")
      .map((meta) => meta.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of customerIds) {
      const { rows } = await tx.query(
        `SELECT id, kind, status, currency_code, balance_minor, event_last_seq
           FROM accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      lockedById.set(BigInt(r.id), {
        id: BigInt(r.id),
        kind: r.kind === "SYSTEM" ? "SYSTEM" : "CUSTOMER",
        currencyCode: String(r.currency_code),
        status: String(r.status) as LockedAccount["status"],
        balanceMinor: r.balance_minor === null ? null : BigInt(r.balance_minor),
      });
      // Test-only hook (P8.10 mutation-B experiment): pause after the FIRST
      // account row is locked so a reversed-order CON-002 run deterministically
      // forms a lock cycle. Never set in production.
      const pauseMs = Number(process.env.BV_TEST_LOCK_PAUSE_MS ?? 0);
      if (pauseMs > 0 && lockedById.size === 1) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }

    // Allocate one event per involved CUSTOMER account (postings AND locked
    // refusals share the per-account sequence — REFUSAL_CODES §5 gap-free).
    const allocateSeq = async (accountId: bigint): Promise<bigint> => {
      const { rows } = await tx.query(
        `UPDATE accounts
            SET event_last_seq = COALESCE(event_last_seq, 0) + 1, updated_at = now()
          WHERE id = $1
          RETURNING event_last_seq`,
        [accountId],
      );
      return BigInt(rows[0].event_last_seq);
    };

    // ---- D-8 step 5: UNDER-LOCK checks (locked rows only).
    const src = command.sourceAccountId !== undefined ? lockedById.get(command.sourceAccountId) : undefined;
    const dst = command.destinationAccountId !== undefined ? lockedById.get(command.destinationAccountId) : undefined;

    const statusRefusal = (): Refusal | null => {
      for (const [id, acct] of lockedById.entries()) {
        if (acct.status === "ACTIVE") continue;
        const visible = isAccountVisible(id);
        // Source: the caller always holds its grant (or the admin cash desk),
        // so the granular 409 applies. Destination: granular only when visible.
        const isSource = id === command.sourceAccountId;
        const external: ErrorCode = isSource || visible ? "ACCOUNT_NOT_ACTIVE" : "ACCOUNT_NOT_FOUND";
        return {
          internalReason: "ACCOUNT_NOT_ACTIVE",
          externalCode: external,
          statusDetail: acct.status === "SUSPENDED" ? "SUSPENDED" : "CLOSED",
        };
      }
      return null;
    };
    const fundsRefusal = (): Refusal | null => {
      if (command.operation === "DEPOSIT" || src === undefined) return null;
      if (src.balanceMinor === null || src.balanceMinor < command.amount) {
        return { internalReason: "INSUFFICIENT_FUNDS", externalCode: "INSUFFICIENT_FUNDS" };
      }
      return null;
    };

    const underLock = statusRefusal() ?? fundsRefusal();
    if (underLock !== null) {
      const rows: Array<{ accountId: bigint | null; balance: Minor | null; seq: bigint | null }> = [];
      for (const id of customerIds) {
        const acct = lockedById.get(id)!;
        rows.push({
          accountId: id,
          balance: acct.balanceMinor,
          seq: await allocateSeq(id),
        });
      }
      await commitBusinessRefusal(tx, command, idempotencyRecordId, underLock, rows);
    }

    // ---- D-8 steps 6–7: post the journal, bump balances, finalise.
    const clearing = await externalClearingAccountId(tx);
    let journal: Journal;
    switch (command.operation) {
      case "DEPOSIT":
        journal = buildDepositJournal({
          destinationAccountId: dst!.id,
          amount: command.amount,
          currencyCode: command.currencyCode,
          externalClearingAccountId: clearing,
        });
        break;
      case "WITHDRAWAL":
        journal = buildWithdrawalJournal({
          sourceAccountId: src!.id,
          amount: command.amount,
          currencyCode: command.currencyCode,
          externalClearingAccountId: clearing,
        });
        break;
      case "TRANSFER":
        journal = buildTransferJournal({
          sourceAccountId: src!.id,
          destinationAccountId: dst!.id,
          amount: command.amount,
          currencyCode: command.currencyCode,
        });
        break;
    }

    const { rows: journalRows } = await tx.query(
      `INSERT INTO journal_transactions
         (type, status, currency_code, initiated_by, idempotency_record_id, description)
       VALUES ($1, 'POSTED', $2, $3, $4, $5)
       RETURNING id`,
      [journal.type, journal.currencyCode, command.actorId, idempotencyRecordId, journal.description ?? null],
    );
    const journalTransactionId = BigInt(journalRows[0].id);

    // One event per involved account: the running balance starts from the
    // locked read and every entry updates the cached balance under the lock.
    const runningBalance = new Map<bigint, Minor>();
    const seqByAccount = new Map<bigint, bigint>();
    for (const id of customerIds) {
      runningBalance.set(id, lockedById.get(id)!.balanceMinor ?? 0n);
    }
    for (const entry of journal.entries) {
      const acct = lockedById.get(entry.accountId);
      let balanceAfter: Minor | null = null;
      let eventSeq: bigint | null = null;
      if (acct !== undefined) {
        const current = runningBalance.get(acct.id) ?? 0n;
        const next = entry.direction === "DEBIT" ? current - entry.amountMinor : current + entry.amountMinor;
        runningBalance.set(acct.id, next);
        balanceAfter = next;
        eventSeq = await allocateSeq(acct.id);
        seqByAccount.set(acct.id, eventSeq);
        await tx.query(
          `UPDATE accounts
              SET balance_minor = $2, event_last_seq = $3, updated_at = now()
            WHERE id = $1`,
          [acct.id, next, eventSeq],
        );
      }
      await tx.query(
        `INSERT INTO ledger_entries
           (journal_transaction_id, account_id, direction, amount_minor, currency_code,
            balance_after_minor, account_event_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [journalTransactionId, entry.accountId, entry.direction, entry.amountMinor,
         entry.currencyCode, balanceAfter, eventSeq],
      );
    }

    await tx.query(
      `UPDATE idempotency_records
          SET response_status = 200,
              response_body = $1,
              journal_transaction_id = $2,
              completed_at = now()
        WHERE id = $3`,
      [JSON.stringify({ status: "SUCCEEDED", journalTransactionId: journalTransactionId.toString() }),
       journalTransactionId, idempotencyRecordId],
    );
    for (const id of customerIds) {
      await tx.query(
        `INSERT INTO transaction_attempts
           (actor_id, operation, status, reason_code, supplied_account_ref,
            account_id, balance_at_attempt_minor, account_event_seq)
         VALUES ($1, $2, 'SUCCEEDED', 'OK', $3, $4, $5, $6)`,
        [command.actorId, command.operation,
         id === command.sourceAccountId ? command.suppliedSourceRef ?? null : command.suppliedDestinationRef ?? null,
         id, runningBalance.get(id) ?? null, seqByAccount.get(id) ?? null],
      );
    }

    await tx.query("COMMIT");
    return { journalTransactionId, replayed: false };
  } catch (error) {
    // The retry wrapper owns classification, rollback and D-9 FAILED rows.
    throw error;
  }
}

/** EXTERNAL_CLEARING system account id (seeded by migration 0004; P6.2/P6.3). */
async function externalClearingAccountId(tx: PoolClient): Promise<bigint> {
  const { rows } = await tx.query(
    `SELECT id FROM accounts WHERE account_number = 'EXTERNAL_CLEARING'`,
  );
  if (rows.length === 0) {
    throw new DomainError("INFRA_FAILURE", "INFRA_FAILURE", "EXTERNAL_CLEARING account missing");
  }
  return BigInt(rows[0].id);
}

/** Format helper re-exported for routes (keeps money serialization in one place). */
export { formatMinor };
