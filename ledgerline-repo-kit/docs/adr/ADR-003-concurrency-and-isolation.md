# ADR-003: Concurrency and isolation — lock order, retries, timeouts (D-7)

- **Status:** Proposed — awaiting Gate 3 human acceptance (lock order declared in the approved Gate 2 Rev 3/4 design; `docs/AUTHZ_MATRIX.md` §D.6)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.3; `phases/PHASE-03-architecture.md`)

## Context

Two withdrawals may race after both read the same balance (T-001); opposite-direction transfers may deadlock if accounts are locked in inconsistent orders (CON-003); role/session revocation and suspension can land mid-transaction (T-046, T-048). The no-overdraft invariant (I3) is human-confirmed for every execution path — "sequential, concurrent, retried, replayed". PostgreSQL is available, so real row-lock behaviour (not SQLite substitutes) is the test target (`phases/PHASE-12` P12.8).

## Decision drivers

- Money correctness under genuine concurrency with independent connections (Gate 8: "race tests fail when the protection is deliberately removed").
- Explainability: the human must be able to narrate the whole lock order from memory (Gate 3 criterion).
- No deadlocks by construction; a stuck request must not hold locks forever.
- Rejected attempts recorded without creating lock contention (Rev 2 lesson: `attempt_seq` allocation must never require a lock the refusal could be waiting on).

## Options considered

1. **`SERIALIZABLE` for everything.** Isolation is automatic, but retry storms on write skew (every money command retries), plus SSI predicate noise, make both outcomes and latency harder to explain; row-level reasoning disappears behind anomaly terms. Also complicates the idempotency claim (a serialisation failure frees the key anyway, but the ordering rules for revocation races — ADR-007 — would need re-derivation).
2. **Atomic conditional `UPDATE … WHERE balance >= amount` for single-account operations with no read-back.** Sufficient for a bare debit, but it gives no under-lock *measured* balance for the refusal audit row, doesn't transfer two accounts atomically, and diverges from the transfer path — two concurrency models instead of one.
3. **Selected: `READ COMMITTED` + explicit row locks in a declared global order** — `SELECT … FOR UPDATE` on all involved **CUSTOMER** account rows, ordered by `id`; balance read only after the lock is held (P8.3). This is the canonical Postgres money-path pattern: each invariant maps to a lock step you can name aloud.

## Decision

1. **Isolation level:** `READ COMMITTED` for every transaction (default). Correctness comes from explicit locking, never from optimistic read timing.
2. **Declared global lock order (money path)** — `PROPOSED_DEFAULTS.md` D-8 / `AUTHZ_MATRIX.md` §D.6, is normative:
   `actor's session row (FOR SHARE) → actor's users row (FOR SHARE) → grant rows (FOR SHARE, ascending id) → idempotency key claim (a unique INSERT — **not** an explicit lock step: no `SELECT … FOR UPDATE` is taken on the key row and no row lock is held by the claim) → customer account rows (FOR UPDATE, ascending id)`.
   *Blocking semantics of the claim (clarified at Gate 3):* PostgreSQL's unique-constraint conflict is what serialises duplicates — a concurrent transaction inserting the same scoped key **waits on the uncommitted unique entry** until the winning transaction commits or rolls back; it never acquires or holds an explicit row lock of its own, so the chain adds no lock class. (`ADR-004` §Decision step 2 describes the same wait-then-read-completed-row behaviour.)
   The admin-lifecycle path is the separate cycle-free chain `admin_control (FOR UPDATE when count-reducing) → target's session rows (ascending id) → target's users row`; both chains agree on the shared `sessions → users` segment.
3. **`FOR SHARE` vs `FOR UPDATE` conflicts** (grant/session revocation, suspension/closure — D-13/ADR-007): a revoker's `UPDATE` against the money command's `FOR SHARE` read has **exactly two legal orders** (revocation first → command refuses; command first → op finishes, revocation then applies to *subsequent* operations). No new lock class is ever added without walking the chain here.
4. **SYSTEM accounts are never locked, never updated** (`EXTERNAL_CLEARING`/`ADJUSTMENT` are ledger-derived, ADR-002); `FOR UPDATE` is taken only on CUSTOMER rows, ascending `id` — the ascending rule makes opposite-direction transfers deadlock-free (CON-003).
5. **Balances are read only after the row locks are held**; `CHECK (balance_minor >= 0)` on CUSTOMER rows is the database backstop if application logic ever slips (I3; the constraint must also be *tested* by deliberately injecting an unlocked negative write in a mutation-check).
6. **Retry policy on `40P01` (deadlock) and `40001` (serialization failure):** retry the **whole command** up to 3 times with the **same** idempotency key. Because the key claim is inside the transaction, a rollback releases the claim (idempotency_records row never commits), so the retry re-claims cleanly and cannot double-apply. A fourth failure returns `503 LOCK_TIMEOUT`-safe semantics: retry-safe with the same key, best-effort `FAILED` write in a separate short transaction (T-035 model).
7. **Timeouts:** `lock_timeout` and `statement_timeout` are set (per-session/transaction) so a stuck request cannot hold locks indefinitely; on timeout the transaction aborts (`503 LOCK_TIMEOUT`, key not consumed, attempt marking is the T-035-safe path — never inside the aborting transaction). Values are configuration, not schema.
8. **Refusal writes never add lock-class to this order:** pre-lock/authorisation refusals carry `account_event_seq = NULL`; `global_seq` comes from a non-transactional SEQUENCE (no row lock, no contention during lock-timeout recovery — approved Rev 2 design); only business refusals recorded under an already-held account lock consume `event_last_seq`.

## Consequences

### Positive
- Every dead-lock-free property is *named* (ascending ids, session-before-users, admin chain separate) and each has a forced-overlap test.
- The two-legal-orders rule gives revocation/suspension races deterministic, explainable outcomes (T-046/T-048 controls).
- One concurrency model for deposit/withdraw/transfer — cheaper to test and explain than split strategies.

### Negative / trade-offs
- Lock waits during hot contention cap throughput — accepted; audit rows use the independent `global_seq` so refusal recording never queues behind it unnecessarily.
- `READ COMMITTED` requires *discipline*: any future code path that checks-then-writes without a lock is a security bug by construction — every money-touching review must name the lock step.

### Risks and mitigations
- *Risk:* future operation introduces a lock not found in this order (cycle risk). *Mitigation:* revisit clause below + `clean-architecture-guard`/`concurrency-test-writing` review checklists require lock-order walk-through on any new lock acquisition.
- *Risk:* long statements (ledger scans) inside the money transaction exceed `statement_timeout`. *Mitigation:* money transactions stay strictly bounded to the D-8 steps — no statements/reconciliations inside them.

## Verification

- `CON-001` two withdrawals race on insufficient combined funds (independent connections); `CON-002` opposite-direction transfers race — final balances still reconcile; `CON-003`/P8.7 deadlock-detection test (zero deadlocks observed or safe retry on 40P01 with equal outcomes); `SESS-001`(session revocation race, T-048); `ROLE-001` (role-change race, T-046); `AUTH-008` (revocation vs in-flight transfer per D-13); `IDEM-003` (20 simultaneous identical requests, one effect); P12.9 mutation check: remove the lock/balance-recheck — the no-overdraft test must fail.
- Timeouts verified by an induced lock-wait (test helper holds `FOR UPDATE` from a second connection) — the waiting command aborts with the retry-safe `503 LOCK_TIMEOUT` envelope, ledger unchanged.

## Revisit conditions

- Any new persistent lock source (queue table, advisory lock, background job touching accounts) → this ADR must be amended with the new node and cycle proof before code merges.
- Measured contention at scale (Phase 12 profiling) shows unacceptable lock queuing → revisit *without* weakening the order: e.g. sharded counters or lock-free `global_seq` additions are allowed; reordering the existing chain is not.
