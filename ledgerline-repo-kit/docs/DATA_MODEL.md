# Data Model — Candidate Relational Schema

This is a design candidate. Inspect existing migrations and obtain human approval before changing schema. Names can adapt; invariants cannot be weakened.

> **Gate 3 final review (2026-11-08) staleness corrections.** Where this document described an alternative that a later ADR has since decided (signed-delta entries, PROCESSING/COMPLETED idempotency states, byte-identical replay, the "decisions still requiring an ADR" list), that text is now labelled **decided / superseded** with an ADR pointer rather than deleted — the normative authority is the ADR + `docs/schema-draft.sql`, not the phase-2 candidate wording here.

## Money representation

- Store money as integer minor units, e.g. ₹1.00 = 100 paise.
- Store currency code on accounts/journals and reject cross-currency transfers in the initial version.
- Never use `float`, `real` or binary floating-point for money.
- Validate amount > 0 and representable in the chosen integer range.
- **JSON serialisation (normative convention):** in API responses **and stored replay bodies**, money and event-sequence integers are **JSON strings**, never bare JSON numbers (`docs/API_CONTRACT.md` / `docs/REFUSAL_CODES.md` §2; T-049). Database columns remain `BIGINT`.

## Candidate tables

### `users`

- `id` primary key
- `email` unique, normalized
- `password_hash`
- `role` constrained to `ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR` (or normalized role table)
- `status`, `created_at`, `updated_at`

### `accounts`

- `id` primary key
- `account_number` unique opaque identifier
- `name` / `label`
- `currency_code`
- `balance_minor` BIGINT NOT NULL CHECK (`balance_minor >= 0`) for no-overdraft policy
- `status` (`ACTIVE`, `SUSPENDED`, `CLOSED`)
- `created_at`, `updated_at`

The cached balance is a read model. It must be updated atomically with journal postings and reconciled against the ledger. If choosing a ledger-derived-only balance, document performance implications and how running balances are calculated.

### `account_permissions`

- `id` primary key
- `user_id` FK
- `account_id` FK
- action/permission (`VIEW`, `DEPOSIT`, `WITHDRAW`, `TRANSFER`, `ADJUST`)
- `granted_by`, `granted_at`, optional `revoked_at`
- unique active grant constraint appropriate to the chosen design

Permission names are a **generic vocabulary and never widen what an operation may do** — `docs/AUTHZ_MATRIX.md` §A/§B is authoritative: `ADJUST` exists only as a placeholder for the **H-5-deferred** ADJUSTMENT feature (not an active v1 capability; no grant of it will exist or be exercised before Gate 9); `DEPOSIT` is **reserved to the ADMIN role under H-2** (holders are never granted it in v1 — a stray grant must never enable a deposit for a holder); `WITHDRAW`/`TRANSFER` are the only holder money grants.

### `journal_transactions`

- `id` primary key / externally safe reference
- `type` (`DEPOSIT`, `WITHDRAWAL`, `TRANSFER`, `ADJUSTMENT`, `REVERSAL`) — `ADJUSTMENT`/`REVERSAL` types are reserved for the **H-5-deferred** feature: **no v1 code path writes them**
- `status` (`POSTED`) — **decided (ADR-004): the `journal_transactions` table holds exactly one status, `POSTED`** — refusals are never represented as journal rows (recorded instead in `transaction_attempts` / the idempotency key row; see ADR-002: "Do not represent a refused attempt as a successful balanced posting" below)
- `currency_code`
- `initiated_by` FK to users where applicable
- `idempotency_record_id` or safe idempotency reference
- `description` / reference
- `created_at`

Do not represent a refused attempt as a successful balanced posting. It may be a separate immutable attempt/audit record linked to the request.

### `ledger_entries`

- `id` primary key
- `journal_transaction_id` FK
- `account_id` FK (including system clearing/control account)
- `side` (`DEBIT` / `CREDIT`) and positive `amount_minor` — **decided (ADR-002): direction-style `DEBIT`/`CREDIT` per entry with always-positive `amount_minor`; the signed-delta alternative is superseded** (column named `direction` in `docs/schema-draft.sql`)
- `currency_code` or inherit/validate from journal/account
- `created_at`

For every posted journal, enforce the chosen balance rule across all entries. Use no UPDATE/DELETE privileges for the application runtime role and/or a DB trigger that rejects mutation. Historical correction is a new compensating journal.

### `transaction_attempts` (or equivalent audit table)

- `id` primary key
- `actor_id` (nullable only for unauthenticated events if safe and useful)
- `operation`, `account_id` where safely known
- `status` (`SUCCEEDED`, `REFUSED`, `FAILED` according to explicit taxonomy)
- `reason_code` safe enum, not sensitive free-form exception text
- `request_reference`, timestamp
- no secrets or raw authorization headers

### `idempotency_records`

- `id` primary key
- `actor_id`, `operation`, `idempotency_key` (or keyed hash)
- `request_hash`
- `status` — **decided (ADR-004): the simpler atomic insert/commit model** — a key row is claimed by a single INSERT (unique constraint) and becomes a persisted outcome at COMMIT; **there is no PROCESSING/COMPLETED state machine** (the earlier PROCESSING/COMPLETED alternative is superseded: a PROCESSING state would be a second claim mechanism without delivering any extra guarantee, and an aborted transaction leaves no key row behind; concurrent duplicates serialise on the unique constraint)
- `response_status`, safe `response_body` or result reference
- `journal_transaction_id` nullable for refused outcomes
- `created_at`, `completed_at`, optional `expires_at`
- unique constraint on the chosen scope, e.g. `(actor_id, operation, idempotency_key)`

Store the result needed to replay the original response. **Replay guarantee (decided, ADR-004 §1a): semantic, not byte-identical.** The stored `JSONB` body preserves the stored HTTP status and identical business field values (money/sequence values serialised as JSON strings, T-049), but JSONB normalises key order, whitespace and number formatting — the first response's exact serialised bytes are not preserved and byte-identical replay is deliberately not promised. Storing original serialised bytes (e.g. `BYTEA`) was evaluated and not chosen (ADR-004 §1a). A replay adds `replayed: true` to the envelope. Do not rely only on an in-memory cache.

## Critical constraints and indexes

- Unique normalized user email and account number.
- Foreign keys for all ownership and journal references.
- Non-negative cached balance under no-overdraft policy.
- Positive amount checks.
- Unique idempotency key scope.
- Index ledger entries by `(account_id, created_at, id)` and journal transaction ID.
- Index permission lookups by `(user_id, account_id, permission)`.
- Restrict ledger UPDATE/DELETE at database permission level for runtime role.

## Decisions that required an ADR — status map (updated at Gate 3 final review)

At the time this document was first drafted these were open; all seven have since been decided in an ADR (none were deleted — pointers preserved):

1. Debit/credit sign convention and account type semantics → **decided in ADR-002** (credit-normal entries, always-positive `amount_minor`, `direction` column).
2. Clearing account behavior for external deposits and withdrawals → **decided in ADR-002** (D-5: `EXTERNAL_CLEARING` SYSTEM account, contra of customer money).
3. Cached balance versus ledger-derived balance strategy → **decided in ADR-002** (D-6: cached customer balance under lock + reconciliation; SYSTEM rows ledger-derived).
4. How refused attempts relate to journal transactions and statement running balances → **decided in ADR-004** (D-9 two-path refusal recording, merged statement timeline per `REFUSAL_CODES.md` §4/§5) and ADR-003 (lock placement).
5. Idempotency handling for refusals and unexpected infrastructure failures → **decided in ADR-004** (D-8/D-9; P3.9 failure-mode table; no-PROCESSING atomic claim).
6. Whether user roles are a single enum or many-to-many role assignments → **decided outside the ADR set, in the human-approved authorization design** — single `role` enum on `users` v1 (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`), per `AUTHZ_MATRIX.md` §A and `docs/schema-draft.sql` (no many-to-many role table exists in v1).
7. Data retention and idempotency-key expiry → **decided in ADR-004** (no-expiry retention in v1; RET-001 tests post-delay replay).

Genuinely **still open / awaiting the human** (not stale — listed to keep honesty): ADR-002's naming-pair detail (`accounts.event_last_seq` / `account_event_seq` closing rule) and closing/merged-timeline approvals recorded in Gate 2 §5a are committed to ADRs but **all ADRs remain Status: Proposed until the human accepts them at Gate 3**; items explicitly deferred by human decision remain deferred (H-5 ADJUSTMENT; replay-side accounting v2 candidate per the section below).


## Additions made by the build kit (required by Phases 5, 6, 9, 10)

### `accounts`: customer vs system accounts
Add `kind` (`CUSTOMER` | `SYSTEM`). The non-negative cached balance applies **only** to `CUSTOMER` rows; `SYSTEM` rows (`EXTERNAL_CLEARING`, `ADJUSTMENT`) have `balance_minor` and the shared per-account event counter `event_last_seq` NULL and are ledger-derived, never locked or cached. See `docs/PROPOSED_DEFAULTS.md` D-5/D-6 for the CHECK (D-6's column is now named `event_last_seq` per the approved Gate 2 decision set — old `last_seq` name superseded). Where the base table above says `balance_minor BIGINT NOT NULL CHECK (balance_minor >= 0)`, read it as customer accounts only.

### `sessions`
- `id`, `user_id` FK, `token_hash` (SHA-256 of the opaque token; the raw token is never stored), `created_at`, `expires_at`, `revoked_at`, optional `user_agent` hash. Unique `token_hash`. Index `(user_id)`.

### `audit_events` (append-only, same privilege rules as the ledger)
- `id`, `occurred_at`, `actor_id` (nullable for failed logins), `event_type` (`LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `PERMISSION_GRANTED`, `PERMISSION_REVOKED`, `ACCOUNT_CREATED`, `ADJUSTMENT_POSTED`, `SESSION_REVOKED`, ... — the identifier `IDEMPOTENT_REPLAY` is **reserved for a possible v2 and is NOT written in v1**: the replay gate is evaluation-only with no replay-side writes, `docs/adr/ADR-004-idempotency-and-refusals.md` §4), `subject_type`, `subject_id`, `reason_code`, `metadata` (safe JSON, no secrets, no raw bodies). Runtime role: `SELECT, INSERT` only.

### `transaction_attempts`: authorisation refusals
Written by a separate short transaction for `FORBIDDEN` outcomes (see D-9); the write is key-state-independent (it never consults `idempotency_records`), so a replaying caller with a committed key history attempts the same single insert per refused call (REPLAY-AUTHZ-001) — one durable row when persistence succeeds; a failed insert is logged and the refusal still returns. Columns as above plus `balance_at_attempt_minor` nullable (NULL when the actor had no right to learn it).

### `transaction_attempts` / `ledger_entries` / `accounts`: event sequencing columns (per `docs/REFUSAL_CODES.md` §4/§5 — approved Gate 2 naming is normative: counter `event_last_seq`, per-entry value `account_event_seq`)
- `accounts.event_last_seq` — the one shared, gap-free, per-account event counter (`BIGINT NOT NULL DEFAULT 0`), bumped only inside a transaction holding that account's `FOR UPDATE` row lock; NULL for SYSTEM rows (above).
- `ledger_entries.account_event_seq` — the posting's allocated event position (consumes the shared counter).
- `transaction_attempts.account_event_seq` — set **only** for business refusals recorded under the account lock; `NULL` for pre-lock refusals, authorisation refusals (`FORBIDDEN`/`ACCOUNT_NOT_FOUND`) and `FAILED` rows.
- `transaction_attempts.global_seq` — from the dedicated non-transactional SEQUENCE `attempt_global_seq` (deliberately non-gap-free; tiebreak for unsequenced rows and admin audit views).
- `transaction_attempts.supplied_account_ref` — the verbatim supplied identifier, always recorded when present (AUTH-009: nonexistent targets carry NO account FK, no `account_event_seq`, no balance).
- `transaction_attempts.account_status_detail` — structured `SUSPENDED`/`CLOSED` detail, only on `ACCOUNT_NOT_ACTIVE` rows written under lock; **ADMIN/AUDITOR audit views only, never exposed to holders or in any external response** (approved decision; `REFUSAL_CODES.md` §4).

### `idempotency_records`: duplicate visibility
**Revised at Gate 3 (replay accounting): v1 records no replay-side writes.** No `replay_count` column and no `idempotency_replays` table exist in v1 — a passing replay is gate-evaluation-only (`docs/adr/ADR-004-idempotency-and-refusals.md` §4): no counter increment, no additional audit row (the `IDEMPOTENT_REPLAY` audit identifier above is reserved-v2, never written in v1). "Which requests were duplicates" is nevertheless answerable from stored data: the key row itself records the attempt (operation, timestamps, request hash, stored outcome), and each replay carries the `replayed: true` field in its response envelope. Per-replay accounting remains a v2 candidate and requires explicit human opt-in before anything is added — the schema draft (`docs/schema-draft.sql`) deliberately omits it.
