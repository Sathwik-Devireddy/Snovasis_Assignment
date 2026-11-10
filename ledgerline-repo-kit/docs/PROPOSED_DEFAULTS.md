# Proposed Defaults — decisions an agent may assume until you override them

These are **recommended defaults**, chosen so the system is correct first and explainable in the live interview.
Phase 3 turns each one into an ADR. Anything marked **HUMAN** needs your explicit approval before code depends on it.
If you change one, update this file and the ADR in the same commit.

## D-1 Stack (HUMAN: approve in Phase 3)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript | Your strongest stack; matches the pack's frontend guidance |
| API | Node.js + TypeScript + Fastify + zod | One language end to end; thin, explicit HTTP layer |
| Database | PostgreSQL, **raw SQL via `pg`** (no ORM) | Locks, transactions and constraints stay visible; easiest to defend live |

> **Amendment (BalanceVault expansion, human instruction 2026-11-09 — the approved D-1 row above stays verbatim):** the expanded challenge mandates **Prisma Client** for typed *routine* database access and **Redis** for API rate limiting. The money path keeps this row's full guarantee — every financial operation is hand-written parameterised raw SQL via `pg` in a single explicit transaction (locks, balance checks, ledger posts, idempotency claims, audit writes). Prisma serves non-financial CRUD only; it connects as the same runtime role to the same database; `node-pg-migrate` remains the sole migration authority; Redis never holds financial/ledger/idempotency state. Boundaries and transaction rules are normative in `docs/adr/ADR-005` §"Data-access transaction strategy"; see `docs/adr/ADR-001` (data-access stacks) and `docs/ARCHITECTURE.md` (BalanceVault expansion).
| Migrations | SQL files run by `node-pg-migrate` (or an equivalent tiny runner) | Reviewable, versioned, runnable from a clean clone |
| Tests | Vitest (unit/integration/concurrency/API), Playwright (UI smoke) | Real PostgreSQL for everything that touches money |
| Local infra | `docker-compose.yml` with PostgreSQL | One command from a clean clone |
| CI | GitHub Actions with a PostgreSQL service container | Proves tests run from scratch |

The pack's baseline was Flask. This kit deviates because the stack must be one **you** can change live under interview pressure.
If you prefer Python, say so before Phase 3; the phases still apply, only the commands change.

Hosting: pick a host where you can create a **second, non-owner database role** (needed for LED-001). Verify this in Phase 4, not Phase 13.

## D-2 Layering (clean architecture, kept small)

```
apps/api/src/
  http/             routes, zod schemas, auth plugin, error mapper   (thin; no business rules)
  application/      use cases: depositMoney, withdrawMoney, transferMoney, createAccount, ...
                    + moneyCommandRunner (transaction + idempotency + attempt recording)
  domain/           pure code, no I/O: Money, journal builder, permission policy, request hashing
  infrastructure/   pg pool, tx runner, SQL repositories, password hasher, clock, id generator
  config/           env parsing and validation
apps/web/           Next.js UI (presentation only)
db/migrations/      versioned SQL
apps/api/test/{unit,integration,concurrency,api}/
```

Dependency rule: `http → application → domain`; `infrastructure` implements what `application` needs.
`domain` imports nothing from the other layers. Introduce an interface only where a second implementation or a test double is genuinely needed (clock, id generator, transaction runner). No repository-interface explosion.

Principles to apply and be able to explain: single responsibility per module, dependency inversion at the transaction/clock boundary, explicit errors (typed domain errors mapped once at the HTTP edge), no business rules in handlers or UI, no shared mutable state, parameterised SQL only.

## D-3 Roles and permissions (HUMAN: approve in Phase 2)

| Role | Can do | Cannot do |
|---|---|---|
| ADMIN | Create users and accounts; grant/revoke account permissions (audited, never to self); perform external DEPOSIT / WITHDRAW on any account (acts as the "cash desk"); post an **ADJUSTMENT** (balanced journal, mandatory reason) — **deferred under H-5, not an active v1 capability** (the permission/audit rows are placeholders; no adjustment code is scheduled before Gate 9); read all statements and audit | Transfer customer money out of an account they hold no TRANSFER grant on; edit or delete ledger rows; grant a permission to themselves |
| ACCOUNT_HOLDER | VIEW own accounts; WITHDRAW and TRANSFER from accounts they hold those grants on; transfer *to* any active account number | See or move another holder's money; change roles/permissions |
| AUDITOR | Read-only: all accounts, statements, attempts, audit events, reconciliation | Any write, including permission changes |

**Deposit policy (HUMAN decision H-2):** default is that only ADMIN holds DEPOSIT. If holders could deposit freely, any user could mint unlimited money in the demo. If you want a holder "top-up" for demo convenience, make it an explicit, capped, audited operation and record it in `THREATS.md`.

Permissions are per account and per action: `VIEW`, `DEPOSIT`, `WITHDRAW`, `TRANSFER`, `ADJUST`. Role says what a user *may ever* be granted; the account grant says what they may do *on this account*. Both are checked on every request, server-side, deny by default. **Capability boundaries of the vocabulary (a permission name never widens an operation):** `ADJUST` is a **placeholder only** — ADJUSTMENT posting is **deferred under H-5, not an active v1 capability** (no grant of it will exist or be exercised before Gate 9); `DEPOSIT` is **reserved to the ADMIN role under H-2** (holders are never granted it in v1; `docs/AUTHZ_MATRIX.md` §A/§B is authoritative).

## D-4 Money

- `BIGINT` minor units (paise). Single currency `INR` in v1; reject anything else. Currency column present and compared, not assumed.
- API field `amount_minor` is validated at the HTTP boundary against the **raw JSON token** (integer literal grammar `-?(0|[1-9][0-9]*)`; no decimals, floats, exponents, `+` or whitespace variants) and converted **directly to `BigInt`** — never via `Number`/`Number.isSafeInteger`, so a 17-digit token cannot silently round into a valid amount (Rev 3 correction for T-049; approved in Gate 2 Rev 4). Tokens whose magnitude exceeds the signed 64-bit BIGINT range → `VALIDATION_FAILED` (transport). `> 0` (i.e. rejecting ≤ 0) and the per-operation cap (suggest 10,00,00,000 paise = ₹10 lakh) are **business** validations → `INVALID_AMOUNT` (409, recorded, NULL balance).
- **Pitfall:** `pg` returns `BIGINT` as a *string*. Convert to `BigInt` in the infrastructure layer; domain arithmetic uses `BigInt`. Never `Number` for sums. **Response serialisation (starting this correction, one rule only — `docs/REFUSAL_CODES.md` §2 / `docs/API_CONTRACT.md`):** every money integer **and every event-sequence integer** (`amount`, `balance_minor`, `balance_after_minor`, `balance_at_attempt_minor`, `account_event_seq`) is serialised as a **JSON string**, never a bare JSON number — including inside replayed response bodies — so no client parser can lose precision (T-049).
- Per-account balance cap via `CHECK` so repeated deposits cannot overflow `BIGINT`.

## D-5 Ledger model: double-entry with a credit-normal convention

- `journal_transactions` (one per movement) and `ledger_entries` (≥2 per journal): `direction` `DEBIT|CREDIT`, positive `amount_minor`.
- Customer account balance = Σ credits − Σ debits. Deposit: debit `EXTERNAL_CLEARING`, credit customer. Withdrawal: debit customer, credit clearing. Transfer: debit source, credit destination.
- Invariant I1: for every journal Σ debits = Σ credits, ≥ 2 entries, one consistent currency. Enforced in the domain builder **and** by a `DEFERRABLE INITIALLY DEFERRED` pair of constraint triggers sharing `assert_journal_balanced()` — anchored on BOTH `journal_transactions` (fires at COMMIT even for a **zero-entry** journal, which a trigger on `ledger_entries` alone could never catch) and `ledger_entries` (`docs/schema-draft.sql`; ADR-002; test JBL-001).
- Global conservation: Σ all balances including clearing = 0; Σ customer balances = −(clearing balance) = net external deposits − withdrawals.
- **Clearing account is never row-locked and never cached.** Locking it would serialise every deposit and withdrawal in the system. Its balance is derived (`−Σ customer balances`, or a ledger sum). Its entries have `NULL` `balance_after_minor` and `account_event_seq`.
- Customer entries (and locked business refusals) carry `balance_after_minor` / `balance_at_attempt_minor` and **`account_event_seq`** — the per-entry event position (per-account, gap-free, allocated under the account row lock by bumping **`accounts.event_last_seq`**; approved Gate 2 naming, supersedes the old `account_seq`/`last_seq` names). Statement event rows order by `account_event_seq` — **not by `created_at` and not by `occurred_at` either**: wall-clock timestamps are not assumed monotonic (a transaction that started earlier can still bump the counter later, e.g. after a lock wait), so event order always follows the counter (`docs/REFUSAL_CODES.md` §5).

## D-6 Balance read model

`accounts.kind` is `CUSTOMER` or `SYSTEM` (`EXTERNAL_CLEARING`, `ADJUSTMENT`). Only CUSTOMER accounts have a cached balance:

```sql
kind               TEXT   NOT NULL CHECK (kind IN ('CUSTOMER','SYSTEM')),
balance_minor      BIGINT NULL,
event_last_seq     BIGINT NULL,
CHECK ( (kind = 'CUSTOMER' AND balance_minor IS NOT NULL AND balance_minor >= 0 AND event_last_seq IS NOT NULL)
     OR (kind = 'SYSTEM'   AND balance_minor IS NULL     AND event_last_seq IS NULL) )
```

SYSTEM account balances are always ledger-derived and may be negative (clearing is the contra of all customer money). The posting service refuses to lock or update a SYSTEM row. Customer balance is updated only inside the posting transaction under the row lock. A reconciliation query recomputes balance from entries and must equal the stored value.
A test helper `assertGlobalInvariants(db)` runs after **every** integration and concurrency test: all journals balanced, every stored balance equals ledger sum, no balance negative, conservation holds.

## D-7 Concurrency

- `READ COMMITTED` + `SELECT … FOR UPDATE` on all involved **customer** account rows, ordered by `id`, balance read only after the lock is held.
- The `CUSTOMER` branch of the `CHECK` (balance `>= 0`) is the database backstop if application logic ever slips.
- On `40P01` (deadlock) or `40001` (serialization) retry the whole command up to 3 times with the **same** idempotency key. Because the claim is inside the transaction, a rollback releases it.
- Set `lock_timeout` and `statement_timeout` so a stuck request cannot hold locks forever.

## D-8 Idempotency (one transaction, no "PROCESSING" state to get stuck)

```
BEGIN
  1. authenticate (session) -> actor; the actor's **session row is re-read `FOR SHARE` inside the
     transaction** (first money-path lock, before `users` — SESS-001/T-048; a concurrently revoked
     session fails here with `UNAUTHENTICATED`)
  1b. AUTHORISE inside the transaction: SELECT the actor's `users` row and grant rows for the target
      accounts `FOR SHARE` (in that order, ascending id). Missing/revoked grant -> ROLLBACK, then
      write a REFUSED attempt in a separate short audit transaction (see D-9) and return the single
      uniform 404 `ACCOUNT_NOT_FOUND` envelope (target-visibility rule, `docs/REFUSAL_CODES.md` §3).
      No idempotency row is created.
  2. INSERT idempotency_records (actor, operation, key, request_hash) ON CONFLICT DO NOTHING
       - inserted  -> we are the winner, continue
       - conflict  -> PostgreSQL blocks on the uncommitted unique entry until the other transaction ends.
                      Then read the row: different hash -> 409 KEY_REUSED (canonical conflict code;
                      IDEM-002). Same hash -> REPLAY GATE — an evaluation-only pass in THIS
                      transaction, in the declared lock order, with NO writes, NO counter bump and
                      NO new attempt rows (the no-write vow covers the gate pass and post-claim
                      refusals; pre-claim step-1b refusals follow D-9 and attempt one audit insert
                      per refused call regardless of key state — one durable row when persistence
                      succeeds); the stored response (`replayed: true`) is returned only
                      after every stage passes (see `docs/REFUSAL_CODES.md` §3, "Replay
                      re-evaluation gate"):
                        a. session validity — enforced at step 1: the session row was already
                           re-read `FOR SHARE` there, so a concurrently revoked/expired session has
                           already failed with 401 UNAUTHENTICATED; a revoked session can never
                           reach a stored response (401 — never a 404/409);
                        b. grant/visibility — step 1b also read the target-account grant rows
                           `FOR SHARE` fresh in this transaction (linearised with revocation,
                           D-13/ADR-007), so a grant revoked or visibility lost since the original
                           attempt already refused at step 1b with the single uniform
                           404 ACCOUNT_NOT_FOUND envelope — never the stored outcome;
                        c. account status — re-read the involved customer account rows `FOR SHARE`
                           in ascending id (involved set = deposit destination / withdrawal source
                           / transfer source + destination) and require status ACTIVE on each
                           (decision 11). A still-visible suspended/closed account follows the
                           documented ACCOUNT_NOT_ACTIVE policy: 409 (granular for a destination —
                           stage (b) just re-confirmed the caller can view it, so the
                           target-visibility rule's uniform-404 branch does not apply to a visible
                           account). The `FOR SHARE` read serialises with a concurrent
                           suspension/closure (whose row UPDATE conflicts with it), so
                           replay-vs-suspension has exactly two legal orders and the declared
                           lock order is unchanged — no cycle can form.
                      Gate refusal => ROLLBACK and return the gate's refusal; nothing stored changes
                      (the scoped key's existing records remain its complete history). Gate pass =>
                      COMMIT, then return the stored response.
  3. PRE-LOCK semantic checks — decided from the request plus caller-visible account metadata only,
     BEFORE any account-row lock or balance read (canonical order: `docs/REFUSAL_CODES.md` §2):
     SAME_ACCOUNT, INVALID_AMOUNT (<= 0 / over cap), CURRENCY_MISMATCH, destination kind.
     A refusal here commits a replayable outcome: attempt row with `balance_at_attempt_minor = NULL`
     and `account_event_seq = NULL` (no lock was held, the counter is never bumped), stored on the
     key row; COMMIT.
  4. lock the involved CUSTOMER account rows `ORDER BY id FOR UPDATE` (never SYSTEM accounts);
     read balances only after the locks are held
  5. UNDER-LOCK checks — against the locked rows only (`docs/REFUSAL_CODES.md` §2/§4): status ACTIVE
     on source and destination (decision 11: SUSPENDED blocks both directions), then sufficient funds.
     A refusal here commits a business refusal: attempt row with the under-lock-read balance and an
     allocated `account_event_seq`, stored as the replayable outcome on the key row; COMMIT.
  6. insert journal + entries, update balances (each event bumps `accounts.event_last_seq`)
  7. store response on the idempotency row
COMMIT
```

Global lock order (approved Gate 2 Rev 3/4 design, `docs/AUTHZ_MATRIX.md` §D.6): the money path is
**actor's session row (`FOR SHARE`) → actor's `users` row (`FOR SHARE`) → grant rows (`FOR SHARE`, ascending id) → idempotency row → customer account rows (`FOR UPDATE`, ascending id)**. Admin-lifecycle operations use the separate cycle-free path `admin_control` (count-reducing) → target's session rows (ascending id) → target's `users` row. Both agree on the shared `sessions → users` segment.

- Scope: `(actor_id, operation, idempotency_key)` unique. Same key by another user is a different key.
- Replay still requires the caller to be authenticated as the same actor **and to pass the replay gate** (D-8 step 2c): a revoked/expired session → **401 UNAUTHENTICATED** (never a 404 for a revoked session); a revoked grant or lost account visibility → the single uniform **404 ACCOUNT_NOT_FOUND** envelope; a still-visible but non-`ACTIVE` involved account → **409 ACCOUNT_NOT_ACTIVE**. The gate re-evaluates current visibility/status **per replay request**; it never overwrites the stored outcome, and the **gate itself** never creates an attempt row (a D-9 audit row after a pre-claim step-1b refusal is written by the separate short audit transaction, not by the gate). Pre-claim step-1b authorisation refusals — including those of a replaying caller — attempt that D-9 audit insert for every refused call regardless of key history: one durable row when persistence succeeds; a failed insert is logged, and the refusal still returns. The gate never consults the key row before authorisation, and never needs to.
- A replayed refusal returns the same refusal even if the balance has since changed (the client must use a new key for a new attempt — document this); balance staleness is irrelevant because the replay executes no financial logic — the gate checks only session, grants/visibility and the involved accounts' current `ACTIVE` status.
- Infrastructure failures roll everything back (key not consumed); a best-effort `FAILED` attempt is written in a separate short transaction.
- Retention: keep keys for the life of the demo (no expiry). Document it.
- Honest claim: *at most one financial effect per scoped key, with replay of the stored outcome*. Do not say "exactly once" end to end.

## D-9 Refused attempts

A refusal rolled back with its transaction is a classic audit hole. Two paths:

- **Business refusals** (insufficient funds, inactive account, invalid state) are committed inside the money transaction (D-8 steps 3 and 5 — the pre-lock and under-lock refusal phases).
- **Authorisation refusals** happen before any financial write. The money transaction is rolled back and a **separate short audit transaction** inserts one `transaction_attempts` row (`REFUSED`, `FORBIDDEN`, actor, operation, target account id as supplied, safe reason code, no balances, no request body). If that insert itself fails, log it and still return the refusal; never let an audit failure turn into a money movement — **one insert is attempted per refused call, exactly one durable row when persistence succeeds, and a failed insert never suppresses the refusal response**. The insert is **key-state-independent**: it does not consult the idempotency key row (authorisation precedes the claim by design), so a replaying caller with a committed key history attempts exactly the same one insert per refused call (REPLAY-AUTHZ-001).

Refusals are never ledger postings and never carry fabricated balances. The response to a non-permitted user does not reveal whether the target account exists — nor its status or classification (single uniform 404 `ACCOUNT_NOT_FOUND` envelope, target-visibility rule — `docs/REFUSAL_CODES.md` §0/§3); the audit row records the id the caller supplied. Rate-limit attempt writes per actor so a flood of forbidden calls cannot bloat the audit table (T-042).
Statement view (approved merged-timeline design, `docs/REFUSAL_CODES.md` §5): ledger postings, locked business refusals and unsequenced refused attempts for that account, rendered as **one `timeline` array** with `event`/`attempt` categories; rows recorded under the account lock carry the allocated `account_event_seq` (from `accounts.event_last_seq`); pre-lock/authorisation refusals carry NULL and never fabricate a position; `balance_at_attempt_minor` appears only where the balance was honestly read under the lock (`REFUSAL_CODES.md` §4). `account_status_detail` is never a statement or API-response field (ADMIN/AUDITOR audit views only).

## D-10 Append-only enforcement (answer to "what stops me editing a row?")

Layered, each layer tested:
1. Two database roles: `ledgerline_owner` (runs migrations only) and `ledgerline_app` (runtime). `ledgerline_app` gets `SELECT, INSERT` on ledger tables and `attempts`; **no** `UPDATE`, `DELETE`, `TRUNCATE`.
2. `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger on ledger tables raise an exception.
3. Optional, recommended stretch: per-account hash chain (`row_hash = sha256(prev_row_hash ‖ canonical fields)`), written under the account lock, verified by reconciliation. This makes edits by a privileged operator **detectable**.
4. Accepted residual risk: a database superuser/owner can disable triggers. Disclose it in `THREATS.md`.

## D-11 Authentication

Opaque random session token, stored **hashed** in a `sessions` table, sent in an `HttpOnly; Secure; SameSite=Lax` cookie. Next.js rewrites `/api/*` to the API so the browser sees one origin. Mutating routes require `Content-Type: application/json` and an `Origin` check. `argon2id` password hashing. Rate-limit login; identical error for unknown user and wrong password. Logout revokes the session row.

## D-12 AI inside the product (optional, last)

Rule-based anomaly flags first (large amount, new payee, burst of attempts). Optional LLM summary of reconciliation. Flags are stored in `review_flags`; a human acts on them in the UI. No code path may create a journal from a flag. Both suggestion and human decision are recorded.

## D-13 Permission revocation versus an in-flight operation (ADR-007)

Rule: **authorisation is linearised with revocation.** The money transaction reads the actor's grant rows `FOR SHARE` (D-8 step 1b) and holds that lock to commit. Revocation is an `UPDATE` of the grant row, which conflicts with `FOR SHARE`, so:

- a revocation arriving during an operation **waits** until the operation commits; that operation is allowed to finish (it was authorised at its linearisation point and is ordered *before* the revocation);
- any operation that begins its authorisation read after the revocation commits sees the grant revoked and is refused;
- account suspension is covered by the account row lock and the in-transaction status check; the **replay gate** re-reads the involved account rows `FOR SHARE` under the same declared order (D-8 step 2c), so replay-vs-suspension also has exactly two legal orders — grant/status refusals above use the same linearisation.

No deadlock cycle: the revoker locks only the grant row (and inserts an audit event); the money command takes grant rows first, then accounts. Document this in ADR-007 and prove it with AUTH-008 (revocation racing an in-flight transfer, forced overlap with a test hook; assert the outcome is one of the two legal orders and the ledger stays consistent) and IDEM-006.

## Human decisions you must make

| ID | Decision | When |
|---|---|---|
| H-1 | Ask the placement cell: repo must stay private until deadline, yet hand-in asks for a public repo. When may it go public? Keep their answer. | Today |
| H-2 | Who may deposit (default: admin only) | Phase 2 |
| H-3 | Approve the stack (D-1) | Phase 3 |
| H-4 | Hosting providers (must allow a second DB role) | Phase 4 |
| H-5 | Which optional features, if any (adjustments, hash chain, AI flags, rate limiting) | After Gate 9 |
