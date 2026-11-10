# ADR-007: Permission revocation versus in-flight operations (D-13)

- **Status:** Proposed — awaiting Gate 3 human acceptance
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.6b; `phases/PHASE-03-architecture.md`)

## Context

An administrator may revoke a grant, suspend an account, disable a user or revoke a session **while a money command by that user is still in flight** (T-046, T-048). The challenge asks for defined linearisation: is the in-flight operation cancelled, corrected, or allowed to finish? An ambiguous answer becomes a double-effect race or an inconsistent audit.

## Decision drivers

- Deterministic, explainable outcome for every revocation/command overlap.
- No new lock classes; no deadlock cycles (ADR-003 chain).
- No reverse-timeline audit: history must not claim the operation was un-authorised after the fact.

## Options considered

1. **Allow the operation to finish; revocation takes effect afterwards** via conflict-pair locking (`FOR SHARE` grants/sessions in the command vs `UPDATE` by the revoker) — deterministic; no rollback of financial logic; historical integrity preserved.
2. **Abort in-flight operations on revocation** (e.g. cancel/rollback signal) — requires cooperative cancellation and rollback handling mid-money-transaction; the alternative "auto-reverse after commit" is worse: it fabricates financial history (compensating journals with fabricated context).
3. **Re-check authorisation after commit and compensate** — same fabrication problem as 2; also unbounded.

## Decision

**Authorisation is linearised with revocation (option 1), in the declared lock order.**

1. The money transaction reads the actor's grant rows (and session/users rows) `FOR SHARE` at D-8 steps 1/1b (ADR-003 chain) and holds them to commit. A revocation is an `UPDATE` of the same rows and, by row-lock contradiction:
   - a revocation arriving during an operation **waits** until that operation commits: the operation was authorised at its linearisation point and is ordered *before* the revocation;
   - any operation whose authorisation read happens after the revocation commits sees the revoked grant and is refused (`404 ACCOUNT_NOT_FOUND`/`401` per the visibility rules, never a half-applied state).
2. **Account suspension/closure** linearises at the account row: the command's locked status check (step 5) vs the administrator's status `UPDATE` — two legal orders, same rule; SUSPENDED blocks credits *and* debits (decision 11).
3. **Session revocation** linearises at the session row read (first money-path lock, ADR-006); revocation-by-role-change additionally revokes the target's session rows inside the admin transaction (T-046 control).
4. **Cycle-freeness.** The revoker takes `admin_control` when count-reducing, then the target's session rows (ascending id), then the `users` row; the money command takes its session/users/grants rows `FOR SHARE` and account rows `FOR UPDATE` — the sets intersect pairwise, never in reverse order, so no cycle forms (chain-walked in ADR-003; asserted per-test in the row-race tests).
5. **Replay.** Replay of any stored outcome passes the replay re-evaluation gate (IDEM-006; `REFUSAL_CODES.md` §3) — including, in stage (b), grant logic. A revocation that committed *after* the original attempt therefore does not honour a stored body: the replay gate refuses with the current-authority outcome (uniform-404 / 401 / 409 as defined there; the gate pass and gate-stage-(c) refusals store nothing — `ADR-004` §4). Exactly what "stores nothing" covers: a refusal at the *grants/visibility* stage is refused earlier, at D-8 step 1b **before the key row is read**, and records the ordinary D-9 authorisation-refusal audit row under **best-effort persistence** — one insert attempted per refused call, exactly one durable row when persistence succeeds, key-state-independent; a failed insert is logged and the refusal still returns (D-9's failure rule), so the absence of that row never masks the refusal. A revocation-committed-before-the-retry replay therefore leaves an honest FORBIDDEN row alongside the original attempt's records, without ever exposing the stored body. A revocation that predates the original attempt never created a stored outcome at all — the original execution was refused at its own authorisation read. In both cases the audit record of the original attempt is untouched and truthful, and a passing replay's only trace is the `replayed: true` field in its response.
6. Idempotency remains the guarantee against double effects across retries; the revocation rule never invokes it (never "rolls back" history).

## Consequences

### Positive
- Every overlap outcome is one of exactly two legal orders — testable by forced-overlap concurrency tests and explainable in one sentence each.
- History remains truthful: no retroactive cancellation, no fabricated reversals.
- Zero additional lock classes; zero additional deadlock surface.

### Negative / trade-offs
- Rapid admins' revocations can queue briefly behind an in-flight command (acceptable — sub-second typical) and *must not* be implemented to "await nothing" (that's the silent-race alternative design); the waiting is inherent in the linearisation.

### Risks and mitigations
- *Risk:* revocation implemented as permission-flag flips caught mid-read (nondeterministic double-read). *Mitigation:* grants are rows with explicit revocation `UPDATE`; the money path's single `FOR SHARE` read is the only authority point, and its single read is preserved by the implementation review checklist.
- *Risk:* admin UX expectation mismatch (human believes an in-flight payment is somehow cancelled). *Mitigation:* documented in `AUTHZ_MATRIX.md` §D and interview-prep; ADR kept visibility public.

## Verification

- `AUTH-008`: revocation racing an in-flight transfer (forced overlap with a test hook) — the outcome is one of the two legal orders and the ledger stays consistent.
- `ROLE-001` (role-change race, T-046 chain) and `SESS-001` (session revocation race, T-048) validate the two-legal-orders rule in each pair.
- `IDEM-006` asserts replay gate behaviour after revocation/suspension (also T-028).

## Revisit conditions

- Any new authorisation source (a permission not stored in `account_permissions`) → its lock-set must be added to ADR-003's chain and walked for cycles first.
- If the human later requires "immediate hard cancellation" semantics → new ADR; the compensating-journal fabrication problem must be resolved there, not by editing this rule.
