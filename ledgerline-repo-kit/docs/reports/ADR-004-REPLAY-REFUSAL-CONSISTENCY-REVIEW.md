# ADR-004 review — replaying-caller authorisation refusals vs the evaluation-only replay gate

- **Date:** 2026-11-09
- **Status:** Analysis report for the human — **no normative decision is made here, no normative file is changed by this round.** All seven ADRs remain `Status: Proposed`; Gate 3 remains open; Phase 4 has not started.
- **Prepared by:** AI review round (senior-DB-architect / documentation-review assignment per the human's task instruction)
- **Scope:** design/documentation review of the ADR-004 ADR family. No code, migrations, compose file, CI, deploy, Git actions, or test runs. Nothing in this report may be cited as executed evidence.
- **Constraints honoured:** the four formally accepted Gate 3 technical decisions (`docs/DISCOVERY.md` §5b) are untouched; the unique-INSERT claim stays the only duplicate serialiser; no explicit `SELECT FOR UPDATE` is proposed on the idempotency key; the evaluation-only replay rule is not silently weakened — if the recommended wording change touches a policy, the exact decision the human must make is stated.

> **Decision-record addendum (2026-11-09, second round of the ADR-004 review — supersedes the header above as of this round only; the analysis text below is kept verbatim as the approved decision basis):** the human approved **DEC-1** (Alternative A: preserve pre-claim authorisation-refusal auditing; scope the evaluation-only/no-write guarantee to post-claim replay evaluation and replay-gate refusals), **DEC-2** (correct the replay test/acceptance expectations; add REPLAY-AUTHZ-001 — applied this round in `docs/ACCEPTANCE.md` and `docs/TEST_PLAN.md`), and **DEC-4** (ADR-001 H-4 timing aligned to "before P4.8 deployment" per `docs/DISCOVERY.md` §5b — applied this round). **DEC-3 is deferred**: the §10 alignment edits were NOT applied; they are prepared verbatim in `docs/reports/ADR-004-DEC1-PROPOSED-ALIGNMENT-EDITS.md` and await human review. Seven ADRs remain Proposed; Gate 3 open; Phase 4 unstarted.
- **Prepared by:** AI review round (senior-DB-architect / documentation-review assignment per the human's task instruction)
- **Scope:** design/documentation review of the ADR-004 ADR family. No code, migrations, compose file, CI, deploy, Git actions, or test runs. Nothing in this report may be cited as executed evidence.
- **Constraints honoured:** the four formally accepted Gate 3 technical decisions (`docs/DISCOVERY.md` §5b) are untouched; the unique-INSERT claim stays the only duplicate serialiser; no explicit `SELECT FOR UPDATE` is proposed on the idempotency key; the evaluation-only replay rule is not silently weakened — if the recommended wording change touches a policy, the exact decision the human must make is stated.

---

## 1. Problem statement

The human's task instruction poses one scenario: **a transfer commits successfully under key K; the required grant is later revoked; the client retries with the same key K.**

Three normative claims meet at this scenario:

1. **Authorisation is checked before the idempotency key is ever read** (D-8 steps 1b → 2; approved order, and a confidentiality property — see Alternative C, §5).
2. **Authorisation refusals are durably recorded, unconditionally**, in a separate short audit transaction after the money transaction rolls back (D-9, AUD-002, AUTH-009; `DISCOVERY.md` A4).
3. **A replaying caller whose authority has lapsed is refused by the replay re-evaluation gate — an evaluation-only pass that "writes nothing" and adds "no new attempt rows"** (`IDEMPOTENCY_BEHAVIORS.md` row 7; `REFUSAL_CODES.md` §3; ADR-004 §4; THREATS T-028).

The question: when the retry-with-revoked-grant hits path 2, does it also become a path-3 "refused replay" — and if so, do claims 2 and 3 contradict each other? The finding (§4) is that a **real, quotable contradiction exists at the wording level**, the **mechanism itself is defensible and needs no runtime change**, and the contradiction is resolvable with **one scoping statement** plus **test-expectation corrections** — recommended in §6, awaiting the human's decision.

A second, unrelated finding (§9) concerns ADR-001's H-4 timing clause vs the human-approved Phase 4 workflow.

---

## 2. Existing transaction sequences (as written today)

### 2.1 First-time request (new key), happy path and refusals

Canonical step text is `docs/PROPOSED_DEFAULTS.md` D-8 (quoted ADR-004 §Decision, which defers to D-8 and `REFUSAL_CODES.md` §2–§4 where wordings differ):

```text
BEGIN
  1.  session row re-read FOR SHARE (first money-path lock) — revoked/expired → 401,
      ROLLBACK (no key row, no attempt row)
  1b. users row + grant rows FOR SHARE (ascending id; ADR-007 linearisation) —
      missing/revoked grant or invisible account → ROLLBACK, then a SEPARATE short
      audit transaction inserts one attempt row; return the uniform 404 envelope.
      No idempotency row yet.
  2.  INSERT idempotency_records … ON CONFLICT DO NOTHING (unique claim; the only
      duplicate serialiser — ADR-003 item 2)
  3.  pre-lock semantic checks (SAME_ACCOUNT / INVALID_AMOUNT / CURRENCY_MISMATCH /
      destination kind) — refusal commits a replayable outcome (NULL balance, NULL seq)
  4.  involved CUSTOMER account rows FOR UPDATE, ascending id; balances read after locks
  5.  under-lock checks (status ACTIVE, sufficient funds) — refusal commits a
      replayable attempt row with the measured lock-time balance + account_event_seq
  6.  journal + entries; balances updated; accounts.event_last_seq bumped per event
  7.  response stored on the idempotency row (semantic-replay artifact, JSONB)
COMMIT
```

Key normative facts for this scenario:

- `ADR-004-idempotency-and-refusals.md` step 1b: *"Missing/revoked grant or invisible account -> ROLLBACK, then (separate short audit transaction) insert the refusal attempt row; return the single uniform 404 ACCOUNT_NOT_FOUND envelope. No idempotency row yet."* — the audit insert is **unconditional at this site**; there is no key-state clause anywhere in step 1b. D-9 (`PROPOSED_DEFAULTS.md`) says the same: *"The money transaction is rolled back and a separate short audit transaction inserts one `transaction_attempts` row (REFUSED, FORBIDDEN …). If that insert itself fails, log it and still return the refusal."*
- `REFUSAL_CODES.md` §1/§3: authorisation-refusal class — *"Money tx rolls back (no key consumed); separate short audit tx writes one compact attempt row"*; the `FORBIDDEN` row's attempt-row column says *"Yes (internal FORBIDDEN)"*, with `balance_at_attempt_minor = NULL` and `account_event_seq = NULL` (§4, §5 — this is the "two-sided truth" design; AUD-002/AUTH-009; `DISCOVERY.md` A4 records it as the human-resolved answer to the refused-refusal-vanishes problem).
- Failed audit inserts are logged and the refusal stands (D-9; an audit failure must never become a money movement), and volume is bounded by T-042 per-actor rate limiting only.

### 2.2 Duplicate request (same key), as written

```text
BEGIN
  1.  session re-read FOR SHARE — revoked/expired → 401, ROLLBACK, NO attempt row
  1b. grants/visibility FOR SHARE — revoked grant or lost visibility → ROLLBACK,
      separate audit tx writes the attempt row (unconditional, as above) → uniform 404.
      (The key row is never read on this path.)
  2.  claim INSERT:
        inserted    → winner, continue at step 3
        conflict    → wait on the uncommitted unique entry; read the committed row:
          different request_hash → 409 KEY_REUSED (the only conflict code), ROLLBACK,
                                   no writes (decided "from the key row alone")
          same request_hash      → REPLAY GATE (evaluation-only pass in THIS transaction:
                                   session stage — already enforced at step 1;
                                   grants/visibility stage — already decided at step 1b;
                                   status stage — involved account rows re-read FOR SHARE
                                   ascending id, each must still be ACTIVE)
                                   gate refusal → ROLLBACK, nothing stored changes
                                   gate pass    → COMMIT, return stored response,
                                                  `replayed: true`
  3.–7. as in §2.1
COMMIT
```

Key normative facts for this path:

- `REFUSAL_CODES.md` §3 stage 2 explicitly routes replaying callers to step 1b: *"a grant revoked or visibility lost since the original attempt already refused at step 1b with the single uniform 404 ACCOUNT_NOT_FOUND envelope … — never the stored outcome."*
- The gate's own vow, `REFUSAL_CODES.md` §3 tail: *"A gate refusal rolls the replay transaction back and changes nothing stored: the scoped key's existing records … remain the complete, honest history of the original attempt — a refused replay never fabricates a second attempt row — and only* passed *replays are observable."*
- `IDEMPOTENCY_BEHAVIORS.md` row 7 preamble: the whole pass is described as an *"evaluation-only pass — no writes, no counter bump, no new attempt rows"*, and its stored-data cell adds *"a gate refusal stores nothing"*.
- ADR-004 §4: *"v1 records no replay-side writes anywhere … Gate refusals write nothing."*
- THREATS T-028 mitigation cell lists the revoked-grant→404 case **and** the no-write vow in the same cell: *"revoked grant / lost visibility → uniform 404 envelope; … evaluation-only pass — no new attempt rows, no counter bump, no replay-side writes at all."*

So the documents route a replay after grant revocation to a site that (by D-9's unconditional rule) writes an audit row, while simultaneously declaring (row 7 / §3 tail / T-028) that such a refusal writes no rows. Which claim actually governs the runtime is determined by the mechanism, and the mechanism follows D-9. §4 shows the resulting write-site reality; §5 shows the contradiction formally.

---

## 3. The replaying-caller lifecycle under the current mechanism (exact ordering)

Transfer succeeds (journal posted; key row K carries the stored success; one SUCCEEDED attempt row). Admin revokes the grant. Client retries with key K:

1. Money tx `BEGIN`; session row `FOR SHARE` — session is valid, passes (stage (a) equivalent: a revoked **session** would 401 here with **no** attempt row — see the asymmetry note below).
2. Step 1b: `users` + grant rows `FOR SHARE` — the grant is revoked → refusal:
   - money tx `ROLLBACK` (no account lock was ever taken, no balance read, no seq allocation, no counter bump);
   - **separate short audit tx** `BEGIN` → `INSERT transaction_attempts (FORBIDDEN, actor, operation, verbatim supplied_account_ref, NULL balance, NULL account_event_seq, fresh global_seq from the non-transactional SEQUENCE)` → `COMMIT`;
   - uniform `404 ACCOUNT_NOT_FOUND` envelope returned.
3. The idempotency key row is **never read** on this path; the replay gate (stages (a)–(c)) is **unreachable** from step 1b's refusal — the claim INSERT at step 2 never executes.

Observable properties to keep in view:

- **No leak.** The stored success body cannot be exposed by this path: the key row is never opened, the response is never deselected; the caller gets the same uniform 404 envelope a first-time unauthorised caller gets (T-020/target-visibility rule intact; TIMING-001's single-code-path property also holds — it *is* the single code path).
- **No financial or sequence effect.** No journal, no balance change, no `account_event_seq`, no `event_last_seq` bump. INV-001's gap-freeness is untouched (authorisation rows never claim sequence values, §5 point 2).
- **No new lock class.** The audit tx touches only the attempt table + `nextval` (`REFUSAL_CODES.md` §5; ADR-003 item 8: *"Refusal writes never add lock-class to this order"*). The money tx's lock set is the standard session/users/grants `FOR SHARE` prefix of the declared order; the FORBIDDEN path never reaches accounts.
- **Revocation semantics are exactly ADR-007's two legal orders.** If the revoking `UPDATE` commits before step 1b's `FOR SHARE`, this request refuses; if the original had still been in flight, the revoker would have waited (linearisation preserved — nothing retroactive).
- **Volume:** each same-key retry that is refused at step 1b adds one compact FORBIDDEN row, bounded only by T-042's per-actor rate limit.

### The asymmetries the current mechanism produces (write-site map)

| Refusal site | Which replay case lands there | Attempt row written? | Key row read? | Server can tell it is a replay? |
|---|---|---|---|---|
| Step 1 (session) | replay after session revocation | **No** (step 1: "no key row, no attempt row") | No | No |
| Step 1b (grants/visibility) | replay after grant revocation / lost visibility | **Yes — unconditional D-9 audit row per refused call** | No | No |
| Step 2, hash mismatch | replay with different payload | No (`KEY_REUSED`: "a second row would fabricate history") | Yes | Yes |
| Step 2, gate stage (c) | replay with suspended/closed-but-visible account | **No** ("gate refusals write nothing") | Yes | Yes |

Two documented-nowhere asymmetries fall out, labelled for reference as **F-2** (gate vs pre-claim sites write differently) and **F-3** (revoked-session replay → 401 with no attempt row; revoked-grant replay → 404 with an audit attempt row). Both are *defensible as designed* — a session is not an accountable-target domain (REFUSAL_CODES §1 transport class: no attempt row where there is no auditable target), while an authorisation refusal is (A4/AUD-002) — but the documents never state that the asymmetry is deliberate, which invites a future "fix" that would break one side or the other.

---

## 4. Is it a real contradiction? — verdict

**Yes — a real, quotable contradiction at the wording/expectation level. At the mechanism level there is no contradiction to fix, and the mechanism must not be "fixed" into one.** The precise structure:

### 4.1 The contradictory claims, pairwise

For the single case *same scoped key + same request hash + caller's grant revoked since the original commit*, the documents simultaneously assert:

- **Claim W1 (no-row vow).** `THREATS.md` T-028: for replay-after-*grant-revocation* specifically — *"uniform 404 envelope; … evaluation-only pass — no new attempt rows, no counter bump, no replay-side writes at all."* Also `IDEMPOTENCY_BEHAVIORS.md` row 7 preamble (*"no writes, no counter bump, no new attempt rows"*, with its (b) stage routing to step 1b) and ADR-004 §4 (*"v1 records no replay-side writes anywhere"*).
- **Claim W2 (unconditional audit).** ADR-004 step 1b / `PROPOSED_DEFAULTS.md` D-9 / `REFUSAL_CODES.md` §1+§3: the authorisation-refusal path, which stage (b) explicitly shares with replays, **always** writes one attempt row in the audit transaction. This is not an incidental detail of this ADR — it is the human-resolved A4 answer (`DISCOVERY.md` §3: *"business refusals are committed outcomes inside the money transaction; authorisation refusals are written in a separate short audit transaction"*), holding AUD-002 (refused rows survive rollback), AUTH-009 (persistence test) and A8 statement completeness. The kit's own mission line — *"every successful or refused attempt can be explained from durable records"* — and the AGENTS.md protocol (*"Record refused attempts as required by the product's statement/audit design"*) depend on W2.
- **Claim W3 (the sentence).** `REFUSAL_CODES.md` §3 tail: *"a refused replay never fabricates a second attempt row."*

W1/W3 say: zero new attempt rows for this retry. W2 says: one per refused call (T-042-capped). They cannot both govern the same request.

### 4.2 Why the mechanism is nonetheless defensible (and why the contradiction is wording-shaped)

- **The server cannot classify the retry as a replay at that point.** Step 1b runs before the key row is read, by an approved property (authorisation-before-claim — see Alternative C, §5). Authority-lapse refusal is decided from grants/session state, which the server *does* know; "is this a replay" is knowledge the server *cannot* have without reading the key row. So the FORBIDDEN row written here is not "a replay-side write" in any causal sense — it is the ordinary, honest audit record that *this call, by this actor, on this operation, was refused for lack of authorisation*. Two different calls (the original success and this refused retry) producing two rows is not "fabricating a second attempt row for one attempt"; it is one row per attempt.
- **The gate's evaluation-only property is literally preserved.** The refusal happens *before the claim*; the gate — the post-claim evaluation pass — was never reached, so nothing it does violates the vow. The write belongs to the D-9 audit mechanism, a different, deliberately contention-free transaction (ADR-003 item 8: refusal writes add no lock class).
- **The security posture is exactly what row 7 promises externally.** Stored response withheld behind the uniform 404; no leak channel; no financial effect; two-legal-orders linearisation preserved (§3 above).

So the defect is **specification-level, not mechanism-level**: the documents teach a runtime-stable interpretation outside its true scope, and the test/acceptance layers then *codify the misreading*:

- `docs/TEST_PLAN.md` `idempotencyReplay.test.ts` — covers the revoked-grant→404 case and then asserts *"every replay path is evaluation-only — no new attempt rows, no counter bump."*
- `docs/TEST_PLAN.md` `replayAfterRevoke.test.ts` — *"nothing stored changes on a gate refusal"* (the same row groups the revoked-grant 404 case under the gate).
- `docs/ACCEPTANCE.md` IDEM-006 — *"evaluation-only pass: no new attempt rows, no counter bump"* over a description that includes the revoked-grant 404 arm.

As specified, the audit-existence assertion would **fail against the designed mechanism** — a genuine spec-vs-mechanism mismatch (and spec-vs-spec: W1 vs W2) in exactly the case the task asked about. Conversely, if the tests were "made to pass" by suppressing the audit row, that would weaken W2/AUD-002 — the wrong fix, discussed as Alternative B.

### 4.3 One-line verdict

> For a same-key retry refused at step 1b, the design (correctly) writes one D-9 authorisation-refusal row per refused call, while `IDEMPOTENCY_BEHAVIORS.md` row 7's preamble, `REFUSAL_CODES.md` §3's tail sentence, `THREATS.md` T-028's cell, ADR-004 §4's scope, `TEST_PLAN.md` and `ACCEPTANCE.md` IDEM-006 all say that a refused replay adds no attempt rows. The evaluation-only vow must be re-scoped to the gate (and the post-claim sites); step-1b authorisation auditing must be declared key-state-independent — exactly one scoping paragraph, no runtime change.

---

## 5. Alternatives

Each alternative is analysed against the required dimensions: transaction sequence, PostgreSQL lock behaviour, unique-key-conflict behaviour, revocation semantics, replay attempt-row behaviour, auditability of authorisation failures, leak risk, new lock classes, validity of existing tests/invariants, and new failure modes. The invariant list used: I1 conservation, I3 no-overdraft, INV-001 sequence gap-freeness, IDEM-002/003/004, AUD-002/AUTH-009, A8 statement visibility, T-020/T-028, TIMING-001 single-path property.

### Alternative A — re-scope the vow; declare authorisation auditing key-state-independent (recommended)

**What changes: wording and test expectations. Nothing at runtime: no schema, no migration, no step order, no lock, no code path.**

- **Policy statement to adopt (the exact decision text the human must approve is in §8):**
  1. *"No replay-side writes"* (ADR-004 §4, IDEMPOTENCY row 7, T-028) means: the replay **gate pass** and all **post-claim refusals** (KEY_REUSED; gate stage (c)) never write — no counter bump, no attempt row, no audit row. It does **not** reach the pre-claim refusal sites (steps 1 and 1b), which follow their own recording rules.
  2. Authorisation auditing at step 1b is **key-state-independent**: it fires identically for a first-time request and for a caller retrying a key with stored history, because the server decides authorisation from grants/session state and cannot (by the authorisation-before-claim property) and should not (by the T-020 envelope uniformity) distinguish the two there.
  3. Every authorisation-refused call records its D-9 attempt row (AUD-002/AUTH-009), rate-limited per actor by T-042. The attempt row records *a call being refused*; the key row records *the intent's committed history*. A stored success followed by FORBIDDEN rows from the same key is honest compound history, not a fabrication.
- **Documented code precedence ladder** (to be stated once, in ADR-004 and referenced elsewhere): transport validation → **401** (session, step 1; no rows) → **uniform 404** (grants/visibility, step 1b; D-9 audit row, key-state-independent) → **409 KEY_REUSED** (hash mismatch from the key row alone; no row) → **409/404 ACCOUNT_NOT_ACTIVE** (gate stage (c) only, reachable only via the gate; no row) → stored outcome + `replayed: true` (gate pass; no writes). This ladder also fixes the second-order ambiguity that a different-payload replay by a *currently-unauthorised* caller must return the **404 envelope, not 409 KEY_REUSED** — KEY_REUSED being decided only after 1b passed.
- **Explicit acceptance of the asymmetries:** F-2 and F-3 stated once (§3 map) as deliberate — session revocation is an authentication failure with no attempt row; grant/visibility loss is an auditable authorisation failure with one attempt row — so no future round "harmonises" them by breaking A4 or the transport-class rule.
- **Exact sequence / locks / conflict / revocation semantics:** unchanged from §2/§3 (the FOR SHARE prefix, the unique claim as sole serialiser, two-legal-orders on every revocation interaction, the contention-free audit tx).
- **Attempt rows on replays:** only for replays refused at step 1b (one per refused call, T-042-bounded); none for KEY_REUSED, none for gate stage (c), none for gate passes; none for revoked-session 401s.
- **Auditability:** fully preserved — arguably *improved*, because the audit trail's meaning is now stated ("rows record refused calls") instead of asserted via a vow it does not meet.
- **Leak:** none (unchanged; the 404 envelope and stored-body-withholding behaviour are untouched).
- **New lock classes:** none.
- **Existing tests/invariants:** all keep their current meanings for every case *except* the single mis-asserted audit-existence expectation for the step-1b-replay case (see the test matrix, cases 4/10 — a test-expectation correction, not a test weakening; the runtime behaviour asserted today simply cannot exist as specified).
- **New failure modes:** none introduced (no code change). One clarified operating fact: repeated same-key retries by a now-unauthorised actor each add a small FORBIDDEN row, bounded only by T-042 — disclosed as accepted (and consistent with the client contract's own "keep the same key while unsure" rule; a client whose grant was revoked is genuinely unsure).
- **Constraint compliance:** no `FOR UPDATE` on the key; unique INSERT remains the only duplicate serialiser; evaluation-only gate untouched; approved D-8 order untouched.

### Alternative B — key-state-aware auditing (conditional suppress or marker rows)

**What changes: the audit transaction becomes conditional on idempotency-table state. Two sub-variants.**

- **Exact sequence:** money tx refuses at step 1b and rolls back exactly as today; then the audit tx **first** reads `idempotency_records` for `(actor_id, operation, key)` (plain `SELECT`, MVCC snapshot, no locks) and either:
  - **B1 (suppress):** if a key row exists with the **same request hash**, skip the attempt insert entirely;
  - **B2 (marker):** write the row anyway but flagged, which requires a new column (e.g. an `attempt_kind` marker distinguishing "authorisation-refused while this key already had a committed outcome") — a schema change plus §4 field-rule changes plus statement-render rule changes and a migration, i.e. Phase 4 artifacts that are currently blocked regardless of anybody's preference.
- **PostgreSQL behaviour:** the plain read adds no lock class and the audit tx keeps taking no account/money locks, so the *lock geometry* is unchanged. But the audit tx's *decision now depends on another table's committed state at read time*. In the revocation-races-the-loser scenario (an original still uncommitted when the loser's 1b refuses), the snapshot decides one way and a commit a moment later realises the other — the suppression policy is **non-linearisable** with respect to the money transaction it observes. B1's decision is only deterministic where the original outcome is already committed — which is thin comfort for a stated rule.
- **Unique-key behaviour / revocation semantics / leak:** unchanged (the audit tx is still post-rollback; no claim exists; uniform envelope intact).
- **Replay attempt rows:** B1 removes them for claimed keys; B2 replaces them with marker rows — which are still replay-side writes, so B2 fails the letter of T-028's vow even while its flag tries to explain them.
- **Auditability:** B1 **silently discards authorisation refusals** for replaying keys — durably-unrecorded refusals. That weakens AUD-002/AUTH-009's stated purpose, contradicts the mission line ("every successful or refused attempt can be explained from durable records"), and reverses the A4 human decision's spirit (the entire reason D-9 exists is that refusals must not vanish with their transaction). T-042's rate limiter exists precisely to make W2 affordable; suppression treats the audit-diet problem as more important than the audit-completeness problem.
- **Tests/invariants:** B1 would need *new* invariant carve-outs ("AUTH-009 except keys with history") — a hole in a previously airtight rule; B2 needs new schema tests that don't yet exist and can't be created this round.
- **New failure modes:** racy suppression decisions (§ above); a *new code path* in the most contention-sensitive transaction (the audit tx) reading a table its rationale says it shouldn't depend on; operator confusion ("why do some refusals have rows and others not"); for B2, migration + closed-reason-code-adjacent schema work in a frozen pre-Phase-4 state.
- **Verdict: not recommended**, and one of its sub-effects would be a normative change the task told me not to make silently: W2 (AUTH-009/AUD-002) would be rewoven with an exception clause. If the human actually prefers suppression, that is a *new policy decision* to be taken explicitly, not a wording fix.

### Alternative C — authorise after the idempotency claim (reorder)

**What changes: claim first, authorisation second. Examined because a reader might assume "read the key first, then you can tell it's a replay, then don't audit" is the fix.**

- **Exact sequence:** session FOR SHARE → claim INSERT/wait/read → grant/visibility FOR SHARE (now after the claim) → gate → steps 3–7.
- **Lock behaviour:** no new lock class strictly arises (the claim's unique conflict is not a lock — ADR-003's clarified blocking semantics; the FOR SHARE reads keep their conflict pairs). But the *approved* declared order (`AUTHZ_MATRIX.md` §D.6: grants **before** the idempotency touch) is reordered — that is an approval-scope change, needing more than an edit per the kit's own process.
- **Unique-key behaviour — where C breaks normative text:** under today's order, a caller whose grant was revoked gets the **uniform 404** envelope; under C, that same caller can reach the conflict machinery and receive **409 KEY_REUSED** for a different-payload retry — revealing their own key history *after* authorisation should have silenced them, and forcing a rewrite of the settled precedence ("KEY_REUSED … decided from the key row alone — no account status read needed", IDEMPOTENCY row 5) and of the uniform-404 story in `API_CONTRACT.md`/`REFUSAL_CODES.md`. It also hands *every authenticated caller* a new interaction channel with the idempotency table (insert/wait timing) regardless of authorisation — expanding the population that can probe the conflict machinery for a purpose the current design deliberately withholds until authorisation passes (a confidentiality property the pre-claim position guarantees structurally: an unauthorised caller never reaches the key row at all).
- **Does it even fix the contradiction? No.** A replaying caller with a revoked grant still fails the (now post-claim) authorisation stage and still hits the same unconditional D-9 audit write the task asked about — same row, same volume, all new costs paid for nothing.
- **Verdict: rejected.** It reorders an approved decision (not mine to make), buys no fix for the audited-replay case, and introduces both a precedence violation (KEY_REUSED past authorisation) and a broader probe surface (idempotency machinery reachable pre-authorisation).

*(A record for completeness: a read-only "peek" of key state at step 1b to decide whether to audit was considered as a micro-variant of B and shares that alternative's suppression defect plus an extra code path; a session-vs-grant harmonisation — e.g. writing attempt rows for 401s too — was considered and rejected as weakening the §1 transport-class boundary with no stakeholder asking for it. Neither is adopted.)*

---

## 6. Recommendation

**Alternative A** — the smallest technically sound resolution, and the only one that changes no runtime behaviour:

- it preserves every approved decision in force (D-8 order, unique-INSERT serialiser, evaluation-only gate, no-replay-side-writes *for the gate*, D-9, A8, T-020/T-028 outcomes, the four accepted Gate 3 technical decisions);
- it removes the one sentence-class that pretends the pre-claim audit write doesn't happen;
- it makes the test suite assert what the mechanism actually guarantees;
- it does not introduce an explicit `SELECT FOR UPDATE` on the idempotency key, does not weaken the evaluation-only gate (the gate genuinely still writes nothing), and does not touch W2.

The genuine policy element — "the 'no replay-side writes' vow is scoped to the gate and post-claim refusals; authorisation auditing is key-state-independent" — is a naming/scope decision over existing behaviour, not new behaviour; but because T-028, ADR-004 §4 and the tests currently state the unscoped form, **the human's approval is required before any normative edit** (§8).

---

## 7. Test matrix (specification only — nothing has been run)

All cases require **real PostgreSQL** for lock/concurrency semantics (docker-compose service in future CI from Phase 4 onward; never mocked). These are test *specifications*; no tests exist yet, none were executed, and no result is claimed. Assertion helper context: `assertGlobalInvariants` (`TEST_PLAN.md`) wraps every case. Existing test files/IDs are reused where they exist; one new ID is proposed (**REPLAY-AUTHZ-001**, carry-over probe per case 4/10) plus explicit *extensions* to two existing planned files.

Existing-state abbreviations: balances in minor units; `event_last_seq` = `accounts.event_last_seq`.

| # | Case (task item) | Initial DB state | Actors / connections | Ordering / concurrency | Expected HTTP | Journal & balance effect | Idempotency-row effect | Attempt/audit-row effect | `event_last_seq` effect | Test ID (existing / proposed) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | First-time successful transfer | Two ACTIVE CUSTOMER accounts, funded; fresh key; grants in place | 1 holder + (admin seed) | Sequential | `200/201` success body | 1 balanced journal; both balances correct | Key row created **inside** the tx with the stored response | 1 SUCCEEDED row (with measured values where §4 allows) | +2 (debit event, credit event) | `transfer.test.ts` / IDEM-001 basis — existing plan |
| 2 | Same-key successful replay | As case 1 after its commit | Same holder | Sequential | Same status + same business values + `replayed: true` | **None** (single effect stands) | Key row unchanged (stored response reread) | **No** new attempt row | **Unchanged** | `idempotencyReplay.test.ts` — existing plan (IDEM-001) |
| 3 | Same key, different payload | Key row from case 1 present | Same holder | Sequential | `409 KEY_REUSED` (only conflict code) | None | Key row unchanged | No row (the original attempt row already exists) | Unchanged | `idempotencyReplay.test.ts` — existing plan (IDEM-002); decided from the key row alone |
| 4 | Replay after grant revocation | Case 1 committed; grant then revoked | Same holder | Sequential; revocation committed before retry | Uniform `404 ACCOUNT_NOT_FOUND` (not the stored body; **not** `KEY_REUSED` even for a different-payload retry — final-payload sub-case asserts the precedence ladder) | None; no lock ever taken on accounts | Key row untouched | **One FORBIDDEN row per refused retry** (NULL balance, NULL seq, verbatim `supplied_account_ref`); T-042 caps the volume; this is the corrected expectation (replaces the impossible "no new attempt rows" assertion) | Unchanged | **NEW: `REPLAY-AUTHZ-001`** (life in `replayAfterRevoke.test.ts` / `idempotencyReplay.test.ts` after human approval) — real PG needed for the grants `FOR SHARE`-vs-`UPDATE` linearisation |
| 5 | Replay after session revocation | Case 1 committed; session row revoked | (Re)authenticate impossible for revoke-then-replay; the case uses the same token | Revocation committed before retry | `401 UNAUTHENTICATED` (never a 404 for the revocation) | None | Key row untouched | **No** attempt row (step-1 refusal — as designed) | Unchanged | `sessionRevokeRace.test.ts` — existing plan (SESS-001/T-048, "replay after logout refused") + `idempotencyReplay.test.ts` gate arm |
| 6 | Replay after account suspension (account still viewable) | Case-runnable setup with the involved account SUSPENDED, caller's grants intact | Same holder | Sequential; suspension committed before retry | `409 ACCOUNT_NOT_ACTIVE` (still-visible; uniform 404 only if visibility was also lost) | None | Key row untouched | **No** attempt row (gate stage (c) writes nothing — the vow holds here) | Unchanged | `replayAfterRevoke.test.ts` — existing plan (IDEM-006/T-028) |
| 7 | Replay after account closure | Involved account CLOSED, caller's grants intact | Same holder | Sequential | `409 ACCOUNT_NOT_ACTIVE`; internal `account_status_detail = CLOSED` (ADMIN/AUDITOR view only) | None | Key row untouched | **No** attempt row | Unchanged | `accounts.test.ts` lifecycle + `replayAfterRevoke.test.ts` — existing plan |
| 8 | Concurrent duplicate requests | Funded pair; fresh key | **2 independent connections**, same key+payload (extendable to 20, IDEM-003) | Winner inserts claim; loser waits on the uncommitted unique entry, then reads the committed row → gate → replay | Winner executes; loser gets the stored outcome `replayed: true` (or the gate's refusal if authority lapsed meanwhile) | Exactly one journal | One key row; created by the winner | Winner's rows only; loser adds **none** (assuming authority intact) | +2 total, not +4 | `sameKeyRace.test.ts` — existing plan (IDEM-003) |
| 9 | Authorisation refusal on a genuinely new key | Funded target the caller cannot view (or nonexistent id — both sub-cases) | Unauthorised/other holder | Sequential | Uniform `404 ACCOUNT_NOT_FOUND`, envelope identical across exists+forbidden / invisible / absent | None | **No key row** ("No idempotency row yet") | One FORBIDDEN/ACCOUNT_NOT_FOUND row (NULL balance/FK per AUTH-009) | Unchanged | `crossUser.api.test.ts` / `attempts.test.ts` — existing plan (AUTH-001/AUTH-007/AUTH-009/T-020) |
| 10 | Authorisation refusal during a replay attempt | Case 1 committed; grant revoked; retry is refused at step 1b before the key row is read | Same holder | Sequential | Uniform `404 ACCOUNT_NOT_FOUND` (case-4 mechanism, asserted generically: KEY_REUSED and 409-status code are **unreachable** for a now-unauthorised caller — the precedence ladder) | None | Key row untouched | One FORBIDDEN row per refused retry (as case 4) | Unchanged | `REPLAY-AUTHZ-001` (proposed; same file as case 4) |
| 11 | Revocation racing an in-flight original | Funded pair; original transfer in flight (forced-overlap hook) | Holder connection + admin connection revoking mid-flight | Exactly two legal orders, forced both ways | Revoke-commits-first → original refused uniform `404` (+ one FORBIDDEN audit row, no key row); original-commits-first → effect stands, revocation valid for subsequent ops | Either zero effect (order 1) or one journal (order 2); ledger consistent in both | Order 2 leaves the committed key row; order 1 never creates one | Order 1: one FORBIDDEN row; order 2: the SUCCEEDED row only | Order 1: +0; order 2: +2 | `revocationRace.test.ts` — existing plan (AUTH-008/T-041); real PG required |
| 12 | Lost HTTP response after successful commit | Case 1 committed; response never delivered (simulated client) | Same holder | Sequential | Same-key retry replays the stored outcome with `replayed: true` | None (T-030: one effect total) | Key row reread, unchanged | No new rows | Unchanged | `idempotencyReplay.test.ts` — existing plan (IDEM-005/T-030) |

Every "no new attempt row" cell above is exactly where the corrected wording (Alternative A) confirms the mechanism, and case 4/10 is the cell the current documents get wrong. Again: **these specifications have not been executed** — they become runnable Phase 4+ code after documentation approval, migrations, and scaffolding exist.

---

## 8. Human decision required (exact text)

The following decision must be taken by the human before any normative file is edited:

> **DEC-1 (primary).** Adopt Alternative A's scoping of the replay-side-writes vow:
> "The evaluation-only guarantee covers every post-claim refusal and every gate pass: no writes, no counter bump, no attempt rows. It does not reach the pre-claim refusal sites: an authorisation refusal at D-8 step 1b is audited in a separate short transaction (D-9/AUD-002/AUTH-009) **regardless of whether that scoped key has committed history** — the server decides authorisation from grants and sessions, and cannot and should not consult the key row before authorisation. Volume is bounded by T-042. The asymmetry with step-1 session refusals (401, no attempt row) and with gate-stage-(c)/KEY_REUSED refusals (no attempt row) is deliberate."
> — Approve / modify / reject.

Consequential decisions if DEC-1 is approved:

> **DEC-2.** Correct the test/acceptance expectations for which no runtime can exist as currently written: `TEST_PLAN.md` `idempotencyReplay.test.ts` ("no new attempt rows"), `replayAfterRevoke.test.ts` ("nothing stored changes on a gate refusal" — for its revoked-grant arm), `ACCEPTANCE.md` IDEM-006; register the new test ID **REPLAY-AUTHZ-001** (cases 4/10). Approve / modify / reject.
>
> **DEC-3.** Approve the concrete replacement sentences I have drafted for each document (§10 list) — I will present each edit for review before applying, as usual. Approve / modify / reject.
>
> **DEC-4 (H-4, separate).** Align ADR-001 line 49's "verified before Phase 4 code, not at deploy time" to the human-approved preposition ("before the Phase 4 deployment step P4.8"), per §9. Approve / modify / reject.

If DEC-1 is rejected, the alternatives live in this report (B: suppression, with the named AUD-002/mission trade-off; C: reordering, with its precedence violation and no fix) and a new round decides policy explicitly — nothing is edited meanwhile.

---

## 9. Separate finding — H-4 hosting-timing wording conflict

**Kept separate from the ADR-004 analysis per instruction; no H-4 policy is chosen here.**

The statements in tension:

1. `docs/adr/ADR-001-stack-and-layering.md` (Hosting constraint): *"the chosen host must permit a **second, non-owner database role** (`ledgerline_app` of ADR-005); this is verified **before Phase 4 code**, not at deploy time."*
2. The human-approved workflow (`docs/DISCOVERY.md` §5b, 2026-11-08): *"H-4 hosting-provider decision and second-DB-role verification remain open and required **before P4.8 deployment** (hosting decision deferred)."*
3. ADR-001's own risks paragraph: *"H-4 explicitly defers hosting verification **to Phase 4** with a fallback"* — which sits uneasily with its own "(1)" ("to Phase 4" vs "before Phase 4 code").
4. Historical decision line (`DISCOVERY.md` §5 table): *"Verify host capability before Phase 4 code, not at deploy time"* (pre-§5b state).

**Verdict:** a real wording conflict. "Before Phase 4 code" would block P4.1–P4.7 (repo bootstrap, migrations, schema work — the parts that need no hosting provider) until a host is verified; the human's recorded decision says the hosting requirement binds only **before P4.8 (deploy)**. The later, human-stated constraint (2) is the one to govern; items (1)/(3)/(4) predate it.

**Smallest alignment (recommended, for DEC-4):** change ADR-001's hosting-constraint sentence from "verified before Phase 4 code, not at deploy time" to the human-approved reading — e.g. *"verified before the Phase 4 deployment step (P4.8); local PostgreSQL 17.10 / docker-compose remains the development fallback (chosen dev-DB pattern for Phase 4)"* — and leave ADR-001's risks bullet to state the same timing. No hosting provider is selected, no verification is claimed, and nothing else in ADR-001 moves.

---

## 10. Documents requiring aligned wording after human approval (DEC-1..DEC-3)

Nothing below changes until the decisions above are taken. Each item is a scoping/expectation correction, not a mechanism change; no unrelated edits.

| Document | Location | Required alignment (Alternative A) |
|---|---|---|
| `docs/adr/ADR-004-idempotency-and-refusals.md` | Decision step 2 gate header; §3; §4; Verification | State that "no writes / no attempt rows" applies to the gate pass and post-claim refusals, and that the step-1b authorisation refusal is D-9-audited key-state-independently for first-time calls and replays alike; add the code-precedence ladder; reword the failure-mode table's step-1b rows to carry the same scoping; IDEM-006 verification line updated to the corrected expectations |
| `docs/adr/ADR-007-revocation-vs-inflight.md` | Decision item 5 (Replay) | Its "evaluation-only pass, nothing stored" sentence is accurate for gate refusals but incomplete for a stage-(b) refusal, which lands at step 1b and writes the D-9 audit row; add the scoping clause and cross-reference |
| `docs/adr/ADR-003-concurrency-and-isolation.md` | — | **No change required** (its refusal-lock-class claims hold; the lock-order chain is untouched). Confirm-only pass during the alignment sweep |
| `docs/REFUSAL_CODES.md` | §3 stage 2 + §3 tail sentence; §5 | Scope the tail: "a refused replay never fabricates a second attempt row" → "a replay refused *at or after the claim* (KEY_REUSED or gate stage (c)) never fabricates a second attempt row; a replay refused *before the claim* (step 1b) is audited per the Authorisation-refusal path"; stage 2 gains the "decided at step 1b, before any key-row read" clause |
| `docs/IDEMPOTENCY_BEHAVIORS.md` | Header paragraph; row 7 preamble + stored-data cell | Same scoping for "no writes and no new attempt rows"; the (b) stage gains the note that this refusal writes the D-9 audit row per refused retry; "a gate refusal stores nothing" retained for stage (c) with the pre-claim exception stated |
| `docs/PROPOSED_DEFAULTS.md` | D-8 step 2 preamble + replay bullet; D-9 | Bullet "The gate … never creates an attempt row" gains the pre-claim carve-out; D-9 gains "key-state-independent (the audit path does not consult the key row); replays refused here therefore also record one row per refused call" |
| `docs/API_CONTRACT.md` | Idempotency paragraph; error taxonomy | One sentence: a replay refused for grants/visibility returns the uniform 404 and is audited server-side; KEY_REUSED remains below authorisation in the enforced order |
| `docs/TEST_PLAN.md` | `idempotencyReplay.test.ts`; `replayAfterRevoke.test.ts` rows | Replace "no new attempt rows" with the write-site map (no rows for KEY_REUSED/gate-(c)/gate-pass; one D-9 row for step-1b refusals incl. replays; no rows for 401s); register REPLAY-AUTHZ-001 |
| `docs/ACCEPTANCE.md` | IDEM-006 row; AC6.2; register | Same expectation correction; new register row for REPLAY-AUTHZ-001 |
| `THREATS.md` | T-028 cell; T-042 cell | T-028's "no replay-side writes at all" scoped per DEC-1 (its outcome column already states the 404 correctly); T-042 notes that replay-refused-step-1b rows are inside the capped volume |
| `docs/ARCHITECTURE.md` | Money-path invariants paragraph (line ~101) | "replays re-run the gate only (no writes…)" gains the pre-claim carve-out |
| `docs/INTERVIEW_PREP.md` | Replay one-liners | Add the interview-size answer: "a replay after losing grants gets the uniform 404 and its refusal is audited; the gate itself never writes" |
| `docs/DATA_MODEL.md` | `transaction_attempts` prose | One note: authorisation-refusal rows fire per refused call regardless of key history; no schema effect |
| `docs/schema-draft.sql` | — | **No change.** Zero schema, migration, or grant edits in this whole resolution |
| `AUTHZ_MATRIX.md` §D, skills (`idempotent-money-command`), phase docs (P3/Phase 6+ text) | — | Sweep at edit time for the same "gate never writes" phrasing; expected to need only the same one-clause alignment where the phrase stands alone |

---

## 11. Residual risks (after Alternative A, if adopted)

1. **Audit-row growth on repeated unauthorised same-key retries** — bounded only by T-042 (per actor), never by key state. Accepted and documented; the alternative (B) trades an audit-completeness guarantee for the bound, which I recommend against.
2. **Compound audit history can look unfamiliar**: a given key may show a SUCCEEDED attempt followed by FORBIDDEN rows from the same actor. That is honest ("rows record calls; keys record intents") but statement/audit readers need the one-line interpretation, provided by the alignment edits.
3. **F-3 asymmetry is a standing design fact**, not a defect: session-refused replays (401) write nothing; grant-refused replays (404) write one row per refusal. Documented as deliberate so no future round "harmonises" it into either audit noise or an audit hole.
4. **The precedence ladder (401 > 404 > KEY_REUSED > gate 409 > stored outcome) must be stated once and everywhere it is depended on** — especially the "different-payload replay by an unauthorised caller returns 404, not KEY_REUSED" consequence, which the current text leaves implicit and which case 10's test will pin.
5. **Nothing in this round is executable evidence.** The analysis is documentation-only; the mechanism claims are derived from the normative texts and PostgreSQL semantics as documented, and the test matrix is specification. The first executable check arrives with Phase 4+ test code against real PostgreSQL.

## 12. Verification performed this round (and its limits)

- Independent verification available to this round was **source inspection only**: exact-quote re-reads of every normative document in the contradiction's closure (ADR-004, ADR-003, ADR-007, ADR-001, `REFUSAL_CODES.md`, `IDEMPOTENCY_BEHAVIORS.md`, `PROPOSED_DEFAULTS.md` D-8/D-9/D-13, `API_CONTRACT.md`, `TEST_PLAN.md`, `ACCEPTANCE.md`, `THREATS.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `DISCOVERY.md` §5/§5b, `INTERVIEW_PREP.md`, `schema-draft.sql` idempotency/attempts sections, `PHASE-04-foundation-deploy.md`) with file-line citations in §2/§4/§9.
- `bash scripts/verify-kit.sh` was run over the kit after adding this report; its result is reported truthfully in the delivery summary (kit-structure lint only — it is **not** an application/DB test and cannot substantiate any design claim here).
- No application tests, DB probes, migrations, or deploys were executed; no Git commands; no ADR status changed; Gate 3 remains open; Phase 4 not started.
