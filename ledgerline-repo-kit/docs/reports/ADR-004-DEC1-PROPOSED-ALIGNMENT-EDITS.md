# ADR-004 DEC-1 — proposed normative wording alignment (prepared per approved DEC-3 deferral; NOT applied)

- **Date:** 2026-11-09
- **Status:** **Proposal awaiting human review (Rev 2).** No file below has been modified. DEC-1 was approved by the human on 2026-11-09 (adopt Alternative A: preserve pre-claim authorisation-refusal auditing; scope the evaluation-only/no-write guarantee to post-claim replay evaluation and replay-gate refusals) and DEC-2 + DEC-4 were applied in the same round (see `docs/reports/ADR-004-REPLAY-REFUSAL-CONSISTENCY-REVIEW.md` addendum). DEC-3 was **deferred**: this document presents the exact replacement text for every remaining document in the review report's §10 list, for review before any edit.
- **Rev 2 (2026-11-09 — the human's four corrections incorporated; still nothing applied):** (1) the replay-gate stage-(c) code is corrected to **409 `ACCOUNT_NOT_ACTIVE`** everywhere — stage (c) only ever runs for accounts stage (b) just re-confirmed as viewable, so its refusal is always the granular 409; the uniform-404 branch belongs to earlier target-visibility sites, never to stage (c); (2) D-9 audit persistence is qualified at every occurrence: **one insert is *attempted* per refused call; exactly one durable row when persistence succeeds; a failed insert is logged and never suppresses the refusal response** (D-9's existing failure rule); (3) the review's remaining alignment locations are now explicitly covered — ADR-004's P3.9 failure-mode table (§1f, no-change verdict), `REFUSAL_CODES.md` §5 (§3c, optional clarity clause), `IDEMPOTENCY_BEHAVIORS.md` row-7 preamble (§4d); (4) the ADR-004 section header count is corrected four → five (1a–1e, plus the 1f review entry).
- **Scope of each edit:** wording only. No transaction ordering, lock, claim, schema, grant, or refusal-recording mechanism is changed anywhere. The runtime behaviour described is the behaviour the mechanism already has.
- **Shared replacement text (used verbatim below):** *"no replay-side writes"* (ADR-004 §4 / IDEMPOTENCY row 7 / T-028) covers the **replay gate pass and all post-claim refusals** (`KEY_REUSED`, gate stage (c)); the **pre-claim** refusal sites (D-8 steps 1 and 1b) follow their own recording rules — authorisation auditing at step 1b is **key-state-independent** (fires identically for a first-time call and a replaying caller): **one insert is attempted per refused call; exactly one durable row when persistence succeeds; a failed insert is logged and the refusal is still returned (D-9's existing failure rule — an audit failure never suppresses the refusal response)**, T-042-bounded; a session revocation (step 1, 401) writes no attempt row; the code-precedence ladder is **transport validation → 401 (session) → uniform 404 `ACCOUNT_NOT_FOUND` (grants/visibility, step 1b) → 409 `KEY_REUSED` (key row only) → 409 `ACCOUNT_NOT_ACTIVE` (gate stage (c) — always granular: stage (b)'s pass just re-confirmed the account is viewable, so the target-visibility rule's uniform-404 branch never applies to stage (c)) → stored outcome + `replayed: true`**.

## 1. `docs/adr/ADR-004-idempotency-and-refusals.md` — five edits + one review entry

### 1a. §Decision, step 2 gate preamble (inside the text sequence diagram)

**OLD:**
```text
        - same request_hash      -> REPLAY GATE (evaluation-only pass, THIS transaction, declared
                    lock order; NO writes, NO counter bump, NO new attempt rows):
```
**NEW:**
```text
        - same request_hash      -> REPLAY GATE (evaluation-only pass, THIS transaction, declared
                    lock order; NO writes, NO counter bump, NO new attempt rows — the no-write
                    vow covers the gate pass and every post-claim refusal; a refusal earlier,
                    before the claim, follows its own recording rules — see step 1b and D-9):
```

### 1b. §Decision, step 2 stage (b)

**OLD:**
```text
            (b) grants/visibility -> already read FOR SHARE at step 1b (revoked grant or lost
                             visibility => uniform 404 ACCOUNT_NOT_FOUND envelope);
```
**NEW:**
```text
            (b) grants/visibility -> already read FOR SHARE at step 1b (revoked grant or lost
                             visibility => uniform 404 ACCOUNT_NOT_FOUND envelope; refused
                             pre-claim, so this arm never reaches the key row — its D-9
                             authorisation-refusal attempt row is key-state-independent:
                             one insert attempted per refused call (exactly one durable
                             row when persistence succeeds; a failed insert is logged
                             and the refusal still returns — D-9's failure rule),
                             T-042-bounded);
```

### 1c. §Decision §3 (Refusal recording, D-9 two paths), final sentence

**OLD (text):**
> Refusals never appear as postings (ADR-002).

**NEW (text, one sentence inserted before it):**
> The step-1b audit insert is **key-state-independent**: it does not consult the idempotency key row (by design, authorisation precedes the claim), so a caller replaying a key with committed history is refused and audited exactly like a first-time caller — one insert attempted per refused call, exactly one durable row when persistence succeeds, T-042-bounded. If an insert fails, it is logged and the refusal still returns (D-9's existing failure rule — an audit failure never suppresses the refusal response). Refusals never appear as postings (ADR-002).

### 1d. §4 (Retention and replay observability), last sentence

**OLD:**
> Gate refusals write nothing.

**NEW:**
> Gate refusals write nothing. Refusals **before the claim** (steps 1 and 1b) follow their own recording rules: an authorisation refusal at step 1b records the ordinary D-9 attempt row — key-state-independent, one insert attempted per refused call, exactly one durable row when persistence succeeds (a failed insert is logged and the refusal still returns — D-9's failure rule), T-042-bounded; a step-1 session 401 records no attempt row. The asymmetry is deliberate (F-3 of the review report).

### 1e. Verification bullet

**OLD:**
> `IDEM-006` replay gate (401/404/409 outcomes, evaluation-only: no new attempt rows, no counter bump);

**NEW:**
> `IDEM-006` replay gate (401/404/409 outcomes; the gate pass and post-claim refusals are evaluation-only — no new attempt rows, no counter bump; `REPLAY-AUTHZ-001` asserts the pre-claim step-1b replay-refusal: uniform 404 + exactly one audited FORBIDDEN row per refused retry when persistence succeeds — the row count is the D-9 insert's effect, asserted only when persistence succeeds; a failed insert is logged and the refusal still returns);

### 1f. §5 Failure-mode table (P3.9) — Rev 2 review entry (the human's location #3), no table change

**Reviewed:** `docs/adr/ADR-004-idempotency-and-refusals.md` §5 (lines 82–99), the death-sites table, checked line-by-line against the approved DEC-1 scope and the D-9 persistence semantics. **Verdict: no row requires an edit.**

- **`step 1b grant reads`** row already states *"no wallet effects; (if refusal committed, that row exists by design)"* — accurate under the approved scope: a step-1b authorisation refusal that persisted is a committed, durable row (it was written in its own short transaction, so a money-transaction death cannot erase it); the D-9 persistence qualifier (attempt/one-durable-row/failure-logged) governs *how* it got there and is carried by the §1c/§1d edits, not by the death table.
- **No row** attributes a write to the replay gate (rows 8/9 pre-date the gate text; the `after COMMIT` replay row only routes through the gate) — consistent with "the gate pass and post-claim refusals write nothing".
- **`after COMMIT, before HTTP response sent`** and the `Replay path` wording remain exact under the approved scope.
- **Line 99 tail (below the table):** *"a revoked session 401, a hidden account uniform-404, or a now-inactive account 409 refuses before exposing any stored body — and a gate refusal writes nothing."* The final clause is grammatically anchored to "a gate refusal", which under the approved scope means the post-claim gate proper — accurate — but the sentence lists the **pre-claim** uniform-404 arm alongside the gate arms, so a reader could connect "writes nothing" to it. **Optional one-clause recommendation (not counted in the five edits unless adopted):** append `; the pre-claim uniform-404 arm is the step-1b refusal that records its ordinary D-9 audit row (§3)` after "writes nothing". Human decision: adopt or leave the tail as-is.

## 2. `docs/adr/ADR-007-revocation-vs-inflight.md` — one edit (Decision item 5, Replay)

**OLD:**
> 5. **Replay.** Replay of any stored outcome passes the replay re-evaluation gate (IDEM-006; `REFUSAL_CODES.md` §3) — including, in stage (b), grant logic. A revocation that committed *after* the original attempt therefore does not honour a stored body: the replay gate refuses with the current-authority outcome (uniform-404 / 401 / 409 as defined there; evaluation-only pass, nothing stored — `ADR-004` §4).

**NEW:**
> 5. **Replay.** Replay of any stored outcome passes the replay re-evaluation gate (IDEM-006; `REFUSAL_CODES.md` §3) — including, in stage (b), grant logic. A revocation that committed *after* the original attempt therefore does not honour a stored body: the replay gate refuses with the current-authority outcome (uniform-404 / 401 / 409 as defined there; the gate pass and gate-stage-(c) refusals store nothing — `ADR-004` §4). Exactly what "stores nothing" covers: a refusal at the *grants/visibility* stage is refused earlier, at D-8 step 1b **before the key row is read**, and records the ordinary D-9 authorisation-refusal attempt row (one insert attempted per refused call, exactly one durable row when persistence succeeds, key-state-independent — a failed insert is logged and the refusal still returns (D-9's failure rule), so the absence of that row never masks the refusal; a revocation-committed-before-the-retry replay therefore leaves an honest FORBIDDEN row alongside the original attempt's records, without ever exposing the stored body).

## 3. `docs/REFUSAL_CODES.md` — two edits (§3)

### 3a. §3 stage 2 of the replay re-evaluation gate

**OLD:**
> 2. **Grant / visibility** — the target-account grant rows were read `FOR SHARE` fresh at D-8 step 1b, linearised with revocation (ADR-007): a grant revoked or visibility lost since the original attempt already refused at step 1b with the **single uniform 404 `ACCOUNT_NOT_FOUND` envelope** (§3 target-visibility rule) — never the stored outcome.

**NEW:**
> 2. **Grant / visibility** — the target-account grant rows were read `FOR SHARE` fresh at D-8 step 1b, linearised with revocation (ADR-007): a grant revoked or visibility lost since the original attempt already refused at step 1b with the **single uniform 404 `ACCOUNT_NOT_FOUND` envelope** (§3 target-visibility rule) — never the stored outcome. This refusal happens **before the key row is read** (the idempotency claim is a later claim than authorisation by design), so the replaying caller is indistinguishable from a first-time caller here; it records the ordinary D-9 authorisation-refusal attempt row — **key-state-independent: one insert attempted per refused call, exactly one durable row when persistence succeeds** (a failed insert is logged and the refusal still returns — D-9's failure rule; T-042-bounded). See `REPLAY-AUTHZ-001`.

### 3b. §3 gate tail

**OLD:**
> A gate refusal rolls the replay transaction back and **changes nothing stored**: the scoped key's existing records (its attempt row(s) and stored response) remain the complete, honest history of the original attempt — a refused replay never fabricates a second attempt row — and only *passed* replays are observable:

**NEW:**
> A gate refusal rolls the replay transaction back and **changes nothing stored**: the scoped key's existing records (its attempt row(s) and stored response) remain the complete, honest history of the original attempt — a **post-claim** refused replay (`KEY_REUSED`, or the gate's stage-(c) status refusal) never fabricates a second attempt row, while a replay refused **pre-claim**, at D-8 step 1b, is audited per the Authorisation-refusal path above (one D-9 insert attempted per refused call — exactly one durable FORBIDDEN row when persistence succeeds; a failed insert is logged and never suppresses the refusal) — and only *passed* replays are observable:

### 3c. §5 Sequencing model — Rev 2 review entry (the human's location #3), optional clarity clause

**Reviewed:** `docs/REFUSAL_CODES.md` §5 (lines 116–137), the Rev 4 sequencing model, checked against the approved DEC-1 scope.

- **§5 item 2** (unsequenced rows) already classes `FORBIDDEN`/`ACCOUNT_NOT_FOUND` authorisation refusals as carrying `account_event_seq = NULL` and `balance_at_attempt_minor = NULL` — consistent with D-9 and with the approved scope; **no change required**. (A step-1b pre-claim refusal always fails before any account-row lock, so it can never claim an event sequence — the classification is exact.)
- **§5 item 3** carries the best-effort rule for `FAILED` rows only (*"on failure the error is logged, the response stands, nothing recurses"*). The **authorisation-refusal insert's** failure rule lives in D-9 (ADR-004 §3; PROPOSED_DEFAULTS §5c of this proposal), and §5 nowhere states the persistence semantics for that path — not a contradiction, only an omission of one derived sentence the D-8/D-9 documents now carry.
- **Optional clarity clause (recommended, not counted as a contradicting fix):** append to §5 item 2, after "(AUTH-009)":
  > **Authorisation-refusal persistence (D-9):** one insert is attempted per refused call (key-state-independent — a replaying caller's refusal records identically to a first-time caller's, `REPLAY-AUTHZ-001`); exactly one durable row when persistence succeeds; a failed insert is logged, the refusal still returns, and T-042 bounds the volume.

  Human decision: adopt the clause or rely on D-9/ADR-004 as the single source (the ladder of references already resolves it).

## 4. `docs/IDEMPOTENCY_BEHAVIORS.md` — four edits (header + row 7 ×3: sub-item (b), stored-data cell, preamble)

### 4a. Header paragraph, scope sentence about the gate

**OLD:**
> The gate is an evaluation-only pass with no writes and no new attempt rows (`REFUSAL_CODES.md` §3).

**NEW:**
> The gate is an evaluation-only pass with no writes and no new attempt rows (`REFUSAL_CODES.md` §3); the no-new-rows guarantee covers the gate pass and post-claim refusals — a replay refused **pre-claim** at step 1b records the ordinary D-9 authorisation-refusal row (key-state-independent: one insert attempted per refused call, exactly one durable row when persistence succeeds; REPLAY-AUTHZ-001).

### 4b. Row 7 sub-item (b)

**OLD:**
> (b) *grants/visibility* — the target grant rows were read `FOR SHARE` fresh at step 1b (linearised with revocation, ADR-007): grant revoked or visibility lost → the single uniform **404 `ACCOUNT_NOT_FOUND`** envelope;

**NEW:**
> (b) *grants/visibility* — the target grant rows were read `FOR SHARE` fresh at step 1b (linearised with revocation, ADR-007): grant revoked or visibility lost → the single uniform **404 `ACCOUNT_NOT_FOUND`** envelope (this refusal occurs before the key row is read and attempts one D-9 authorisation-refusal insert per refused call — key-state-independent; exactly one durable row when persistence succeeds, T-042-bounded);

### 4c. Row 7 stored-data cell

**OLD (two fragments):**
> **v1 records no replay-side writes** (no counter bump, no `IDEMPOTENT_REPLAY` audit row, no replay counter/table: `docs/adr/ADR-004-idempotency-and-refusals.md` §4, deferred to v2 with human opt-in); a gate refusal stores nothing |

**NEW:**
> **v1 records no replay-side writes** in or after the gate (no counter bump, no `IDEMPOTENT_REPLAY` audit row, no replay counter/table: `docs/adr/ADR-004-idempotency-and-refusals.md` §4, deferred to v2 with human opt-in); a gate refusal stores nothing (a pre-claim step-1b refusal attempts one ordinary D-9 authorisation-refusal insert per refused call — exactly one durable row when persistence succeeds; a failed insert is logged and never suppresses the refusal; a step-1 session 401 records none — the deliberate F-3 asymmetry) |

### 4d. Row-7 preamble (Rev 2 addition — the human's location #3)

**Target (verified, `docs/IDEMPOTENCY_BEHAVIORS.md` line 19, the row-7 `Caller receives` preamble):**
> | 7 | **Replay after grant revoked / account no longer `ACTIVE` / session revoked** | **Replay re-evaluation gate** (same transaction, declared lock order, evaluation only — no writes, no counter bump, no new attempt rows): (a) *session* …

**Verdict:** the preamble needs the **same one-clause scoping** the header paragraph gets in §4a — otherwise the row contradicts the approved scope exactly like the header sentence did. **Stage (c) needs NO correction here:** it already reads *"suspended/closed but **still viewable** → **409 `ACCOUNT_NOT_ACTIVE`**"* — 409-only, verified verbatim; no `409/404` defect exists in row 7.

**NEW (inserted clause, in place):**
> … (same transaction, declared lock order, evaluation only — no writes, no counter bump, no new attempt rows; the no-write vow covers the gate pass and post-claim refusals — a replay refused **pre-claim** at step 1b records the ordinary D-9 authorisation-refusal row, one insert attempted per refused call, REPLAY-AUTHZ-001): (a) *session* …

## 5. `docs/PROPOSED_DEFAULTS.md` — three edits

### 5a. D-8 step 2 gate preamble

**OLD:**
> Same hash -> REPLAY GATE — an evaluation-only pass in THIS
> transaction, in the declared lock order, with NO writes, NO counter bump and
> NO new attempt rows; the stored response (`replayed: true`) is returned only
> after every stage passes (see `docs/REFUSAL_CODES.md` §3, "Replay
> re-evaluation gate"):

**NEW:**
> Same hash -> REPLAY GATE — an evaluation-only pass in THIS
> transaction, in the declared lock order, with NO writes, NO counter bump and
> NO new attempt rows (the no-write vow covers the gate pass and post-claim
> refusals; pre-claim step-1b refusals follow D-9 and attempt one audit insert
> per refused call regardless of key state — one durable row when persistence
> succeeds); the stored response (`replayed: true`) is returned
> only after every stage passes (see `docs/REFUSAL_CODES.md` §3, "Replay
> re-evaluation gate"):

### 5b. D-8 replay bullet (below the D-8 block)

**OLD:**
> The gate re-evaluates current visibility/status **per replay request**; it never overwrites the stored outcome and never creates an attempt row.

**NEW:**
> The gate re-evaluates current visibility/status **per replay request**; it never overwrites the stored outcome and never creates an attempt row. (Pre-claim step-1b authorisation refusals — including those of a replaying caller — attempt the D-9 audit insert for every refused call regardless of key history: one durable row when persistence succeeds, a logged-and-suppressed-refusal-never failure otherwise; the gate never consults the key row before authorisation, and never needs to.)

### 5c. D-9 authorisation-refusal bullet

**OLD:**
> - **Authorisation refusals** happen before any financial write. The money transaction is rolled back and a **separate short audit transaction** inserts one `transaction_attempts` row (`REFUSED`, `FORBIDDEN`, actor, operation, target account id as supplied, safe reason code, no balances, no request body). If that insert itself fails, log it and still return the refusal; never let an audit failure turn into a money movement.

**NEW:**
> - **Authorisation refusals** happen before any financial write. The money transaction is rolled back and a **separate short audit transaction** inserts one `transaction_attempts` row (`REFUSED`, `FORBIDDEN`, actor, operation, target account id as supplied, safe reason code, no balances, no request body). If that insert itself fails, log it and still return the refusal; never let an audit failure turn into a money movement — **one insert is attempted per refused call, exactly one durable row when persistence succeeds, and a failed insert never suppresses the refusal response**. The insert is **key-state-independent**: it does not consult the idempotency key row (authorisation precedes the claim by design), so a replaying caller with a committed key history attempts exactly the same one insert per refused call (REPLAY-AUTHZ-001).

## 6. `docs/API_CONTRACT.md` — one edit (Money-movement idempotency paragraph)

**OLD (final sentences of the paragraph):**
> … A previously refused attempt replays the same refusal — likewise only via the gate. The API must document response behavior for an in-flight duplicate and a previously refused attempt.

**NEW:**
> … A previously refused attempt replays the same refusal — likewise only via the gate. A replay refused by the **authorisation stage** is refused before the key row is consulted and returns the uniform `404 ACCOUNT_NOT_FOUND` envelope; its refusal is audited server-side — one D-9 insert attempted per refused call, exactly one durable audit row when persistence succeeds, T-042-bounded (a failed insert is logged and the refusal still returns) — and `KEY_REUSED` sits **below** authorisation in the enforced order — a now-unauthorised caller never receives `409 KEY_REUSED` for a key they can no longer honour. The API must document response behavior for an in-flight duplicate and a previously refused attempt.

## 7. `THREATS.md` — two edits

### 7a. T-028 mitigation cell

**OLD:**
> | T-028 | Replay succeeds after permission revoked, account suspended, or session revoked | Unauthorised information or confusion | **Replay re-evaluation gate** before any stored outcome (D-8 step 2 / `IDEMPOTENCY_BEHAVIORS.md` row 7): revoked/expired session → 401 `UNAUTHENTICATED`; revoked grant / lost visibility → uniform 404 envelope; involved account rows re-read `FOR SHARE` (ascending id) and must still be `ACTIVE` → else 409 `ACCOUNT_NOT_ACTIVE`; evaluation-only pass — no new attempt rows, no counter bump, **no replay-side writes at all** (`ADR-004` §4: the only replay trace is the `replayed: true` response field); exactly two legal orders vs concurrent suspension | IDEM-006 | OPEN |

**NEW:**
> | T-028 | Replay succeeds after permission revoked, account suspended, or session revoked | Unauthorised information or confusion | **Replay re-evaluation gate** before any stored outcome (D-8 step 2 / `IDEMPOTENCY_BEHAVIORS.md` row 7): revoked/expired session → 401 `UNAUTHENTICATED` (no attempt row); revoked grant / lost visibility → refused **pre-claim** at D-8 step 1b → uniform 404 envelope **plus the ordinary D-9 authorisation-refusal attempt row — one insert attempted per refused call, exactly one durable row when persistence succeeds** (approved DEC-1 scope 2026-11-09; REPLAY-AUTHZ-001); involved account rows re-read `FOR SHARE` (ascending id) and must still be `ACTIVE` → else 409 `ACCOUNT_NOT_ACTIVE` (gate stage (c): no attempt row); evaluation-only gate pass — no new attempt rows, no counter bump, **no replay-side writes in or after the gate** (`ADR-004` §4: the only replay trace is the `replayed: true` response field); exactly two legal orders vs concurrent suspension | IDEM-006, REPLAY-AUTHZ-001 | OPEN |

### 7b. T-042 mitigation cell

**OLD:**
> | T-042 | Flood of forbidden calls bloats the audit/attempts table | Denial of service, noisy evidence | Per-actor rate limit on attempt writes; compact rows; audit failure never changes the response | load smoke test | OPEN |

**NEW:**
> | T-042 | Flood of forbidden calls bloats the audit/attempts table | Denial of service, noisy evidence | Per-actor rate limit on attempt writes (explicitly including replay-refused pre-claim authorisation rows — approved DEC-1 scope); compact rows; audit failure never changes the response | load smoke test | OPEN |

## 8. `docs/ARCHITECTURE.md` — one edit (Money-path invariants)

**OLD:**
> **Always:** no path executes financial logic twice per key; replays re-run the gate only (no writes, no counter bump — ADR-004); refusals are recorded per D-9's two paths.

**NEW:**
> **Always:** no path executes financial logic twice per key; replays re-run the gate only (no writes, no counter bump — ADR-004 §4: the guarantee covers the gate pass and post-claim refusals; a replay refused at the pre-claim authorisation step records the ordinary D-9 authorisation-refusal row); refusals are recorded per D-9's two paths.

## 9. `docs/INTERVIEW_PREP.md` — one addition (interview-size one-liner)

**Location:** the money-path Q&A table (hooks on the "Same request arrives twice" row region).

**NEW ROW:**
> | What if a replaying retry lost its grant? | Refused at the pre-claim authorisation step with the uniform 404 (never the stored body, never `KEY_REUSED`); the refusal is audited — one D-9 insert attempted per refused call, one durable FORBIDDEN row when persistence succeeds, T-042-capped; the gate itself never writes | |

## 10. `docs/DATA_MODEL.md` — one edit (`transaction_attempts`: authorisation refusals)

**OLD:**
> Written by a separate short transaction for `FORBIDDEN` outcomes (see D-9). Columns as above plus `balance_at_attempt_minor` nullable (NULL when the actor had no right to learn it).

**NEW:**
> Written by a separate short transaction for `FORBIDDEN` outcomes (see D-9); the write is key-state-independent (it never consults `idempotency_records`), so a replaying caller with a committed key history attempts the same single insert per refused call (REPLAY-AUTHZ-001) — one durable row when persistence succeeds; a failed insert is logged and the refusal still returns. Columns as above plus `balance_at_attempt_minor` nullable (NULL when the actor had no right to learn it).

## 11. `docs/AUTHZ_MATRIX.md`, skills, phase docs — sweep-verify only (expected: no change or the same one-clause alignment)

- `docs/AUTHZ_MATRIX.md` §D: its two replay mentions ("Replay correctness is preserved for free…", "…replay still re-checks authorisation (IDEM-006)") remain true under the approved scope — **no edit proposed**; confirm at review.
- `.claude/skills/idempotent-money-command/SKILL.md` step-2 gate text ("evaluation only … NO new attempt rows — `docs/REFUSAL_CODES.md` §3"): propose appending the clause `("no new attempt rows" refers to the gate pass and post-claim refusals; pre-claim step-1b refusals record the D-9 audit row — approved DEC-1 scope)` only if the human wants the skill text to carry the scope inline; the skill otherwise defers to the section that is being aligned.
- Phase docs (P6/P7 money-path checklists, `phases/PHASE-06*` / `PHASE-07*`): expected no change; verify at edit time whether any phase checklist repeats the unscoped "no new attempt rows" phrase outside a plain cross-reference.

## 12. What this document deliberately does NOT touch

- ADR-004's transaction shape, D-8 step order, the unique-INSERT claim (no `SELECT FOR UPDATE` is introduced), refusal-auditing mechanism, all ADR statuses (`Proposed` for all seven), Gate 3 state (open), Phase 4 (not started), the schema draft (`docs/schema-draft.sql` — zero changes), and THREATS statuses (all remain OPEN; T-028's status does not change on wording alone).
- The historical records: `DISCOVERY.md` §5's pre-§5b H-4 line, PROMPTS history, and the quotes in `docs/reports/ADR-004-REPLAY-REFUSAL-CONSISTENCY-REVIEW.md` describing the pre-alignment state.

## 13. Rev 2 review log (2026-11-09)

**Trigger:** the human's four corrections to Rev 1. All four incorporated; nothing in this document has been applied to any normative file.

1. **Stage-(c) code = `409 ACCOUNT_NOT_ACTIVE` only.** Shared ladder text corrected (header); the `409/404` compound never appears as a stage-(c) outcome anywhere in Rev 2. Verified against the normative texts: `IDEMPOTENCY_BEHAVIORS.md` row 7 (c) already reads 409-only ("suspended/closed but **still viewable** → **409 `ACCOUNT_NOT_ACTIVE`**"), `REFUSAL_CODES.md` §3's stage (c) already carries the granular 409, and `TEST_PLAN.md`'s applied rows already assert 409. **One applied-text defect discovered by this review, queued for DEC-3 execution (NOT fixed now — it sits in already-applied DEC-2 text, which may not be edited without approval):**
   - `docs/ACCEPTANCE.md`, IDEM-006 register row: contains "`gate-stage-(c) 409/404`" — the gate's post-claim stage (c) refusal can only be 409; **one-token fix queued** (`409/404` → `409`) for the same round DEC-3 is executed (or on its own if the human prefers).
   - No other applied file carries the defect: `TEST_PLAN.md`'s IDEM-006/REPLAY-AUTHZ-001 rows never had it (verified verbatim).

2. **D-9 persistence qualified at every occurrence.** All fifteen proposal sites now state the three-part qualifier: **one insert *attempted* per refused call; exactly one durable row when persistence succeeds; a failed insert is logged and never suppresses the refusal response**. Sites touched: shared text + §1b block + §1c sentence (done in the pre-checkpoint round); this round completed §1d, §1e, §2 (ADR-007), §3a, §3b, §4a, §4b, §4c, §5a, §5b, §5c, §6, §7a (T-028), §9, §10. Swept for stragglers after application (see commands below).

3. **Remaining alignment locations covered.** §1f (ADR-004 §5 failure-mode table: reviewed, **no table change**, one optional line-99 clause flag), §3c (`REFUSAL_CODES.md` §5: items 2–3 reviewed, **no contradiction**, one optional clarity clause), §4d (`IDEMPOTENCY_BEHAVIORS.md` row-7 preamble: scoping clause proposed; stage (c) verified already 409-only in that row).

4. **ADR-004 edit count corrected.** Section 1 heading now reads "five edits + one review entry" (1a–1e are the edits; 1f is the review entry).

**Verification performed in Rev 2:** re-read of the full document post-edit; grep sweeps for unqualified ``one (insert/attempt/D-9 …)? (row|insert)? per refused`` phrasings and for any residual `409/404`; `bash scripts/verify-kit.sh` → `kit OK`.
