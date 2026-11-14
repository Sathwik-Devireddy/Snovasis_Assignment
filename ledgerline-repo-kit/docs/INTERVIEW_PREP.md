# Interview preparation: be able to answer these from your own code

> **Phase 3 (2026-11-14):** the full question set (double-entry, balances,
> concurrency, idempotency, sessions, RBAC, PostgreSQL, Redis, reconciliation,
> DB permissions, timeout-after-commit) is now answered in
> [`INTERVIEW_PREPARATION.md`](INTERVIEW_PREPARATION.md) — answers tied to the
> actual code at the Phase 3 baseline. This file remains the live-drill table
> with file:line references.

Shortlisted candidates walk through the code and make a live change. Update the right-hand column with real file and line references as you build. If you cannot point at the code, you do not yet own it.

| They will ask | You must be able to show | Where (fill in) |
|---|---|---|
| Where exactly is the balance checked and the debit written? | The `FOR UPDATE` lock, the balance read after the lock, the insert of entries, the balance update | `apps/api/src/domain/transactionRunner.ts:625` (lock `FOR UPDATE`), `:618` (ascending id order), `:680` (balance check under the lock → `INSUFFICIENT_FUNDS`), the ledger inserts + cached-balance UPDATE in `executeMoneyTransaction` (one transaction opened at `:375`, committed at `:554`) |
| Are check and write atomic? | One transaction; lock held until commit; `CHECK (balance_minor >= 0)` as backstop | `transactionRunner.ts:375`–`:554` (single `BEGIN`…`COMMIT`); backstop CHECK `accounts_no_overdraft` (`db/migrations/0003_ledger.js`) — **proved** by mutation M1 (dropping it made `CON-001` fail) |
| Two withdrawals arrive at the same instant | Second blocks on the row lock, re-reads the new balance, is refused; test name | `apps/api/test/integration/ledgerCore.test.ts` → `CON-001: concurrent over-balance withdrawals — exactly one succeeds`; mutation M3 (removing the lock) made both succeed — transcript in `THREATS.md` |
| Same request arrives twice | Unique constraint on `(actor, operation, key)`; second inserter waits, then replays | `db/migrations/0002_identity.js` (`idempotency_scope_unique`); the claim `INSERT … ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING` at `transactionRunner.ts:495`; test `IDEM-003` (`ledgerCore.test.ts`); mutation M2 (dropping the constraint) made `IDEM-003` fail |
| What if a replaying retry lost its grant? | Refused at the pre-claim authorisation step with the uniform 404 (never the stored body, never `KEY_REUSED`); the refusal is audited — one D-9 insert attempted per refused call, one durable FORBIDDEN row when persistence succeeds, T-042-capped; the gate itself never writes | `transactionRunner.ts:428`–`:460` (involved accounts re-read `FOR SHARE` + grant read, BEFORE the claim) and `:523`/`:558` (`KEY_REUSED` only for a hash mismatch, never for a lost grant); `docs/IDEMPOTENCY_BEHAVIORS.md` row 7 |
| Retry arrives while the first is in flight | PostgreSQL blocks the duplicate insert until the winner commits or rolls back | `transactionRunner.ts:495` — the UNIQUE index makes the second inserter block on the first transaction's row |
| Same key, different amount | Request hash mismatch → 409, no movement | `transactionRunner.ts:519`–`:523` (canonical request hash compared with the stored one → `KEY_REUSED`); test `IDEM-002`/`IDEM-004` |
| Where does a refused attempt go, and why not rolled back? | Committed `transaction_attempts` row; refusal is a committed outcome | `transactionRunner.ts:204`–`:239` (`commitBusinessRefusal` — its own `BEGIN`/`COMMIT`), `:612` (called instead of the financial path) |
| What stops me editing a ledger row? | Runtime role has no UPDATE/DELETE/TRUNCATE; triggers; (hash chain); residual: owner can bypass | `db/migrations/0002_identity.js:119`–`:123` (`REVOKE ALL` from the runtime role) and `db/migrations/0003_ledger.js` (row + TRUNCATE triggers, firing for the owner too); tests `LED-001`, `LED-001b`, `LED-002`; residual risk T-009/T-026 |
| Why integer minor units? Why BigInt? | `pg` returns BIGINT as string; precision loss above 2^53 | `apps/api/src/domain/money.ts:41` (`parseMinor` — strict integer grammar), `:49` (signed 64-bit range), `:72` (`isInt64Token` for ids); every money field leaves the API as a string (T-049) |
| Why lock in id order? | Opposite transfers A→B and B→A would deadlock otherwise | `transactionRunner.ts:618`–`:621` (`customerIds` sorted ascending before locking) |
| What if the commit succeeds but the response is lost? | Client retries with the same key; replay returns the stored result | `transactionRunner.ts` (the stored `response_body` is replayed on a matching key); test `IDEM-005: lost response — commit succeeds, client retries with the SAME key, stored result replays` (`ledgerCore.test.ts`); web side: `apps/web/lib/money-intent.ts` (the retry reuses the ORIGINAL key and body) |
| Who can deposit and why? | Matrix in `docs/`; self-deposit would mint money | `apps/api/src/domain/transactionRunner.ts` (DEPOSIT branch: ADMIN role only) + `ledgerline-repo-kit/docs/AUTHZ_MATRIX.md`; test `AUTH-003`; adversarial attack `A5 holder deposit` |
| What do you know is still open? | Your `ACCEPTED` risks in `THREATS.md`, stated plainly | `ledgerline-repo-kit/THREATS.md` — T-050 (accepted), T-017/T-018/T-020/T-038/T-063 (OPEN, each with its condition), and `docs/reports/PHASE-12-report.md` revision 3 |
| Make this change live: e.g. add a per-day withdrawal limit | Practise: add one rule in `domain/` + one test, without touching handlers | The rule belongs next to the other under-lock checks in `apps/api/src/domain/transactionRunner.ts` (`:680`) and is proven by a test in `apps/api/test/integration/ledgerCore.test.ts` — no handler change |

## Practice drills (do each once before Gate 12)

1. Delete the `FOR UPDATE`; run the concurrency test; watch it fail; restore. → **done** (mutation M3 — `THREATS.md`).
2. Swap lock order in transfer; run the opposite-direction test; watch the deadlock; restore. → **not yet run** — the runner already supports a deterministic lock cycle through the sanctioned `BV_TEST_LOCK_PAUSE_MS` hook and `CON-002` covers it.
3. Remove the unique constraint; run the duplicate-key test; watch it fail; restore. → **done** (mutation M2 — `THREATS.md`).
4. Add a new refusal reason end to end (domain → statement → test) in under 20 minutes. → exercise of the refusal path: `commitBusinessRefusal` → `transaction_attempts` → `docs/REFUSAL_CODES.md` → a test in `apps/api/test/api/money.api.test.ts`.
