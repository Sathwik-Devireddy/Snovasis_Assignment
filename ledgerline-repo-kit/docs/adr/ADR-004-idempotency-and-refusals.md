# ADR-004: Idempotency and refusal recording (D-8, D-9) — sequence diagram and failure modes

- **Status:** Proposed — awaiting Gate 3 human acceptance (transaction shape from the approved Gate 2 Rev 3/4 design incl. the Rev 4b replay re-evaluation gate; `REFUSAL_CODES.md` §2–§4, `IDEMPOTENCY_BEHAVIORS.md`)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.4 + P3.8/P3.9 failure-mode deliverable; `phases/PHASE-03-architecture.md`)

## Context

A retry must never move money twice (requirement 6; T-030: commit succeeds but the response is lost). A refusal must survive for audit and statement display even though its transaction is rolled back (T-021, A4). A key reused with a different payload must be rejected (IDEM-002), and a concurrent duplicate must not create a second execution (IDEM-003). Gate 2 Rev 4b additionally resolved the replay contradiction: a stored response is returned **only after** a re-evaluation gate passes (IDEM-006, `docs/REFUSAL_CODES.md` §3).

## Decision drivers

- "At most one financial effect per scoped key, with replay of the stored outcome" — the honest claim, never "exactly once end-to-end".
- The database, not a client or UI flag, enforces idempotency (AGENTS.md).
- No stuck intermediate state (a "PROCESSING" record that survives a crash would block retries indefinitely).
- Refusals must be auditable without leaking balances the actor had no right to learn (§4).

## Options considered

1. **Stateful key lifecycle** (`PROCESSING` → `COMPLETED`) — classic pattern, but a crash between states strands a `PROCESSING` row; needs TTL/lease machinery and conditional-transition logic; extra failure modes in a system where the client is told "always use the same key".
2. **Selected: single atomic model** — the idempotency row is inserted inside the same transaction as the financial effect and stores the committed outcome; either both exist (committed) or neither does. No state column, no lease, no process states. A concurrent duplicate simply **blocks on the uncommitted unique row** and then replays.
3. **Key-expiry retention** — rejected for v1: an expired key inside the retry-safety window is exactly how a delayed retry double-pays (T-017/T-038). Keys are kept for the life of the demo, and retention is documented.

## Decision

**1. Transaction flow (text sequence diagram).** One transaction per money command (canonical step text lives in `PROPOSED_DEFAULTS.md` D-8; where any wording differs, D-8 and `REFUSAL_CODES.md` §2/§3/§4 govern):

```text
BEGIN
  1.  Authenticate: re-read the actor's session row FOR SHARE (first money-path lock,
      before users — SESS-001/T-048). Invalid/revoked/expired -> 401, ROLLBACK (no key row,
      no attempt row).
  1b. Authorise inside the transaction: read the actor's users row + grant rows for the
      target accounts FOR SHARE (ascending id; linearised with revocation, ADR-007).
      Missing/revoked grant or invisible account -> ROLLBACK, then (separate short audit
      transaction) insert the refusal attempt row; return the single uniform
      404 ACCOUNT_NOT_FOUND envelope. No idempotency row yet.
  2.  INSERT idempotency_records (actor, operation, key, request_hash) ON CONFLICT DO NOTHING.
      * inserted  -> winner, continue at 3.
      * blocked   -> wait on the uncommitted unique entry until the other transaction ends,
                    then read the committed row:
        - different request_hash -> 409 KEY_REUSED (the only conflict code); ROLLBACK, no writes.
        - same request_hash      -> REPLAY GATE (evaluation-only pass, THIS transaction, declared
                    lock order; NO writes, NO counter bump, NO new attempt rows — the no-write
                    vow covers the gate pass and every post-claim refusal; a refusal earlier,
                    before the claim, follows its own recording rules — see step 1b and D-9):
            (a) session   -> already enforced at step 1 (revoked/expired => 401 before any
                             stored response; never a 404/409 for the revocation);
            (b) grants/visibility -> already read FOR SHARE at step 1b (revoked grant or lost
                             visibility => uniform 404 ACCOUNT_NOT_FOUND envelope; refused
                             pre-claim, so this arm never reaches the key row — its D-9
                             authorisation-refusal audit row is key-state-independent:
                             one insert attempted per refused call (exactly one durable
                             row when persistence succeeds; a failed insert is logged
                             and the refusal still returns — D-9's failure rule),
                             T-042-bounded);
            (c) account status -> re-read the involved CUSTOMER account rows FOR SHARE,
                             ascending id, each must be ACTIVE => else 409 ACCOUNT_NOT_ACTIVE
                             (still-visible suspended/closed account; the FOR SHARE read
                             serialises with a concurrent suspension/closure — exactly two
                             legal orders, no new lock class, no cycle).
            gate refusal  -> ROLLBACK, return the gate's refusal; nothing stored changes.
            gate pass     -> COMMIT, then return the STORED response envelope, marked `replayed: true`.
  3.  Pre-lock semantic checks (caller-visible data only; canonical order §2): SAME_ACCOUNT,
      INVALID_AMOUNT (<= 0 / over cap), CURRENCY_MISMATCH, destination kind.
      Refusal: COMMIT a replayable outcome — attempt row (REFUSED, NULL balance,
      NULL account_event_seq) + the refusal response on the key row.
  4.  Lock the involved CUSTOMER account rows ORDER BY id FOR UPDATE (never SYSTEM rows);
      read balances only once locks are held.
  5.  Under-lock checks: status ACTIVE on source and destination (SUSPENDED blocks both
      directions — decision 11), then sufficient funds.
      Refusal: attempt row with the under-lock-read balance and an allocated
      account_event_seq (counter bumped under the lock), stored on the key row; COMMIT.
  6.  Insert journal + entries; update balances; bump accounts.event_last_seq per event.
  7.  Store the response (status + business body, money/sequences as JSON strings —
      DATA_MODEL.md idempotency-records section) on the idempotency row. The stored
      JSONB is the *semantic-replay artifact*, not a byte-image of the first response.
COMMIT
```

**1a. Replay guarantee (Gate 3 final review — replaces the earlier "byte-identical" wording).** The guarantee is **semantic replay of the stored financial outcome**: a replay returns the stored HTTP status and the identical business field values (amounts and event-sequence values serialised as JSON strings — T-049), with `replayed: true` added to that replay's envelope. It is deliberately **not** a byte-identical claim: `response_body` is stored as `JSONB`, and JSONB normalises key order, whitespace and numeric formatting — two serialisations of the same outcome can differ byte-level while being semantically identical. Storing the original serialised bytes (`BYTEA`) was considered and not chosen: it duplicates the payload, buys byte equality for exactly one response type while every other API response is generated per request, and creates a second source of truth for the response shape; the T-049 canonical string serialisation already preserves precision both in the first response and on replay. If the human ever *requires* byte-identical replays, that is a new ADR (new storage layout + per-replay trade-offs), not a wording tweak. Keep the existing guarantee unchanged: **at most one financial effect per scoped key**.

**2. Scoping and conflicts.** Uniqueness on `(actor_id, operation, idempotency_key)`: the same key string from another user, or for another operation, is a different key (IDEM-004, T-027). The only conflict response is `409 KEY_REUSED`. A concurrent duplicate is not a conflict: the loser waits, then passes the replay gate (or receives its refusal) (IDEM-003). Enforced by the database unique constraint — never by a UI state.

**3. Refusal recording (D-9) — two paths.** *Business refusals* (steps 3 and 5) are committed **inside** the money transaction as replayable outcomes: `transaction_attempts` row (REFUSED + safe `reason_code`), balance recorded **only where the balance was actually read under the account lock** (§4 balance matrix); the key row carries the refusal response for replay. *Authorisation refusals* (step 1b happens before any wallet write) are recorded in a **separate short audit transaction** after ROLLBACK: attempt row with the `supplied_account_ref` verbatim, no account FK, no balances, no request body (AUTH-009; a nonexistent target can have none). If that audit insert itself fails, it is logged and the refusal still returns — an audit failure must never become a money movement. Attempt-write rate limiting per actor stops a flood of forbidden calls bloating the audit table (T-042). The step-1b audit insert is **key-state-independent**: it does not consult the idempotency key row (by design, authorisation precedes the claim), so a caller replaying a key with committed history is refused and audited exactly like a first-time caller — one insert attempted per refused call, exactly one durable row when persistence succeeds, T-042-bounded. Refusals never appear as postings (ADR-002).

**4. Retention and replay observability.** No expiry in v1 (T-017/T-038); documented in `IDEMPOTENCY_BEHAVIORS.md`. **v1 records no replay-side writes anywhere.** A passing replay is evaluation-only: no counter increment, no additional audit row, no `IDEMPOTENT_REPLAY` event. Its only observable marker is the `replayed: true` field on that replay's response envelope (plus the stored key row the replay read). This is deliberate, not an oversight: replay-side accounting would either contradict the evaluation-only gate (a write inside stage (b)/(c)'s `FOR SHARE` pass) or require an extra transaction per replay (new failure modes; and a client retrying in a loop would inflate any replay counter — a T-042-family attractor). "Which requests were duplicates" remains answerable from stored data without any replay-side bookkeeping: the `idempotency_records` key row itself (operation, timestamps, request hash, stored outcome) is the duplicate record, and the `replayed: true` envelope field marks each replay at response time. **Per-replay accounting (a `replay_count`-style column or an append-only `idempotency_replays` table) is deferred to a later version and requires explicit human opt-in before anything is added** — deliberately absent from the v1 schema draft (`docs/schema-draft.sql`). Gate refusals write nothing. Refusals **before the claim** (steps 1 and 1b) follow their own recording rules: an authorisation refusal at step 1b records the ordinary D-9 attempt row — key-state-independent, one insert attempted per refused call, exactly one durable row when persistence succeeds (a failed insert is logged and the refusal still returns — D-9's failure rule), T-042-bounded; a step-1 session 401 records no attempt row. The asymmetry is deliberate (F-3 of the review report).

**5. Failure-mode table (P3.9) — what happens if the process dies at each step.** Postgres atomicity: everything inside an uncommitted transaction vanishes on death; an uncommitted unique row releases its claim on rollback; a committed transaction is durable.

| Death during / after… | Stored effect | Idempotency outcome | Caller position |
|---|---|---|---|
| before BEGIN (transport) | none | none | Retry with the same key; server never saw it. |
| step 1 session read | none | none | Retry same key. 401 if a revocation won the race. |
| step 1b grant reads | no wallet effects; (if refusal committed, that row exists by design) | key never claimed | Retry same key; gate still applies. |
| step 2 claim INSERT (uncommitted) | claim vanishes on death | not consumed | Retry same key: re-inserts cleanly. A was-waiting duplicate wins instead. |
| step 3 commit of pre-lock refusal | attempt row + key row carry the refusal (intentional committed outcome, NULLs per §4) | replay returns the same refusal via the gate | Same key replays the refusal — even if the balance has since changed. |
| step 4/5 lock wait or under-lock read | none yet | claim released by rollback | Retry same key immediately (40P01/40001/timeout paths of ADR-003). |
| step 5 commit of under-lock refusal (e.g. INSUFFICIENT_FUNDS) | attempt row with measured balance + `account_event_seq`; key row stores refusal | replay returns the same refusal even if the balance later increases (the *client* must use a new key for a genuinely new attempt) | Gate still required before the stored body. |
| step 6 journal/entries (uncommitted) | whole tx rolls back (FIN-002 irrelevancy: no partial, persisted posting exists) | claim released | Retry same key; at most one effect (I1 conservation intact). |
| step 7 response store (uncommitted) | whole tx rolls back | claim released | Retry same key. |
| during the final COMMIT | Postgres atomic: either the full outcome (journal + balances + key row + response) or nothing | — | Retry same key. |
| after COMMIT, before HTTP response sent | durable complete outcome; response body stored | replay path: same claim, gate, then stored body `replayed: true` | **The** lost-response case (T-030): same-key retry recovers the outcome. |
| infra failure (pool break etc.) | rolled back; key not consumed | none | Retry same key; best-effort `FAILED` audit row in a separate short transaction (T-035; must not contend for money-path locks). |

Any replay of a committed outcome still passes the replay gate first (IDEM-006): a revoked session 401, a hidden account uniform-404, or a now-inactive account 409 refuses before exposing any stored body — and a gate refusal writes nothing; the pre-claim uniform-404 arm is the step-1b refusal that records its ordinary D-9 audit row (§3 of this ADR, best-effort persistence: one durable row when the audit insert succeeds; a failed insert is logged and never suppresses the refusal).

## Consequences

### Positive
- No permanent stuck state; every infrastructure death leaves a retry-safe position while the key stays free or the outcome stays replayable.
- Every refusal is durable, classified (business vs authorisation), and honest about what balances it may carry.
- The unique row is the mutex — concurrency requirements (IDEM-003) fall out of DB constraints, not application queues.

### Negative / trade-offs
- The gap-free `account_event_seq` allocation sits inside the money transaction by design — this is why replay must never re-run steps 4–5 (a replayed attempt would allocate a **second** sequence; the gate is evaluation-only precisely to avoid fabricating one).
- Response bodies stored duplicately per key (replayable outcome per attempt) — trivial storage cost at demo scale.

### Risks and mitigations
- *Risk:* the gate and the §2/§4 wording drift apart between documents. *Mitigation:* `REFUSAL_CODES.md` §3 is normative; D-8, `IDEMPOTENCY_BEHAVIORS.md`, `API_CONTRACT.md` cross-reference it and are re-swept after edits (Rev 4b method).
- *Risk:* a future developer "optimises" replay to skip the gate. *Mitigation:* IDEM-006 test (row 7) asserts the refused-replay outcome codes explicitly.

## Verification

- `IDEM-001` sequential replay: same status and same business body, marked `replayed: true` (semantic replay — ADR-004 §1a; not a byte-for-byte body claim), one journal; `IDEM-002` hash-mismatch → `KEY_REUSED`, no movement; `IDEM-003` 20 simultaneous identical requests (independent connections) → exactly one effect; `IDEM-004` cross-user key independence; `IDEM-005` lost-response replay; `IDEM-006` replay gate (401/404/409 outcomes; the gate pass and post-claim refusals are evaluation-only — no new attempt rows, no counter bump; `REPLAY-AUTHZ-001` asserts the pre-claim step-1b replay-refusal: uniform 404 + exactly one audited FORBIDDEN row per refused retry when persistence succeeds — the row count is the D-9 insert's effect, asserted only when persistence succeeds; a failed insert is logged and the refusal still returns); `RET-001` replay after artificial delay; `T-030` trace; refusal-recording paths (`AUD-002`, AUTH-009 persistence test); `T-042` rate cap.
- Failure-mode table exercised at least at the three designed checkpoints in Phase 9 (kill tests: after commit-before-response; mid-transaction; around the claim insertion).

## Revisit conditions

- Client demands *exactly-once* end-to-end semantics → impossible claim; document, do not reimplement.
- New operation types (e.g. ADJUSTMENT under H-5) reuse this flow — the flow is extended step-wise here, never forked.
- If retention was ever proven to block a real retry window → re-open no-expiry with a documented, evidence-based proposal; TTL alone never removed.
