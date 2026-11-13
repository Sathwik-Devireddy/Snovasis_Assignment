# Phase 9: Idempotency proof

**Target:** Mon 9 Nov. **Agents:** 05 backend, 08 QA. **Skills:** idempotent-money-command, concurrency-test-writing, mutation-check.

## Objective
Prove, **in stored data**, that a key causes at most one financial effect, and that duplicates are visible.

## Tasks
- [ ] P9.1 **IDEM-001:** sequential replay returns the same status and the same business body, marked `replayed: true` (semantic replay — ADR-004 §1a; not a byte-for-byte body claim; JSONB storage normalises serialization); one journal, one set of entries.
- [ ] P9.2 **IDEM-002:** same key, changed amount or destination → 409 `KEY_REUSED` (canonical conflict code); no movement.
- [ ] P9.3 **IDEM-003:** 20 simultaneous identical requests on separate connections → exactly one effect; all responses equal.
- [ ] P9.4 **IDEM-004:** another user using the same key string is independent and never sees the first user's result.
- [ ] P9.5 **IDEM-005:** simulated lost response (commit then client retries) replays the stored result.
- [ ] P9.6 **IDEM-006:** the **replay re-evaluation gate** (`docs/IDEMPOTENCY_BEHAVIORS.md` row 7; `docs/REFUSAL_CODES.md` §3) — before any stored response is returned: revoked/expired session → **401 `UNAUTHENTICATED`** (the session row is re-read `FOR SHARE` at D-8 step 1, *before* the claim; a revocation is never a 404); revoked grant or lost visibility → the single uniform **404 `ACCOUNT_NOT_FOUND`** envelope; a still-visible suspended/closed account → **409 `ACCOUNT_NOT_ACTIVE`** (involved account rows re-read `FOR SHARE`, ascending id — exactly two legal orders vs concurrent suspension; evaluation-only pass: no new attempt rows from the gate pass and post-claim refusals, no counter bump — a replay refused **pre-claim** at D-8 step 1b records one D-9 authorisation-refusal audit insert per refused call (durability best-effort per D-9; REPLAY-AUTHZ-001)). The stored response returns only when the whole gate passes.
- [ ] P9.7 Replayed refusal returns the same refusal — via the same replay gate (P9.6); a new key is a new attempt. Document in API docs.
- [ ] P9.8 Duplicates visible in data — **Gate 3 revision (evaluation-only replays)**: prove from stored data that a replay adds **no** rows anywhere: no new `idempotency_records` row (the same key row holds the committed outcome), no `replay_count` increment, no `idempotency_replays` entries, no `IDEMPOTENT_REPLAY` audit row — those surfaces do not exist and shall not be created in v1 (`docs/adr/ADR-004-idempotency-and-refusals.md` §4; per-replay accounting is deferred and requires human opt-in). Duplicate visibility is the key-row list (operation + timestamp + outcome) in the audit view, plus the `replayed: true` field in the replay's response envelope.
- [ ] P9.9 **Mutation check:** drop the unique index; confirm IDEM-003 fails; restore.

## Acceptance (Gate 9)
Assertions count rows in `journal_transactions`, `ledger_entries` and `idempotency_records` (the stored key rows — one committed outcome per scoped key; v1 has no per-replay record: a replay writes nothing, its only trace is the `replayed: true` response field), not just HTTP statuses.

## Closeout
Update T-003, T-004, T-005, T-017, T-027, T-028, T-030, T-038. `PROMPTS.md` entry (idempotency).
