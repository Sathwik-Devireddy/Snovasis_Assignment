# PHASE-03-FINAL-GATE-3-REVIEW.md — Gate 3 Final Technical Correction and Verification

- **Date:** 2026-11-08
- **Phase:** 3 (final pass) · **Type:** documentation/design correction + independent verification · **Agent:** 03/04 collaboration, reviewed as an independent technical reviewer
- **Constraints honoured:** documentation-only; no Phase 4 start; no application code, migrations, endpoints or dependencies; no destructive database operations; no Git commits or fabricated links; no ADR marked Accepted; human-approved decisions preserved; no invariant weakened; every judgment-call decision recorded as AI-recommended and human-overridable.
- **Companion evidence:** `PROMPTS.md` entry of the same date; cross-document sweeps recorded there.

> **Post-review decision record (2026-11-08, from the human).** The human has **formally accepted the four technical decisions of §5** (provenance recorded in `docs/DISCOVERY.md` §5b) — but Gate 3 is **not** closed: the human has not yet individually reviewed and accepted ADR-001…ADR-007 as complete documents, so **all seven ADR statuses remain `Proposed`** and migration work stays blocked. Phase 4 was instructed, then held by the human's same clarification: **no Phase 4 work has started** (no scaffold, no migrations, no commits, no claims). Gate 4 preconditions recorded by the human: individual ADR acceptance; H-1 placement-cell decision on repository visibility; verification of the private-repository setup; Docker Desktop operational (verified 2026-11-08: engine **not** running; the human chose docker-compose as the Phase 4 dev-DB pattern); H-4 hosting decision + second-DB-role verification before P4.8.

---

## 1. Initial findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **High** | Session revocation documented as `UPDATE sessions SET status = 'REVOKED'` in `AUTHZ_MATRIX.md` §D.3a, but the schema defines **no** `status` column on `sessions` — two state representations, one unimplemented | **Corrected** |
| F2 | **Critical** | The journal-balance trigger was anchored on `ledger_entries` only: a `journal_transactions` row inserted with **zero entries** would commit as a valid POSTED financial transaction (no entry row ⇒ no trigger event); the draft checklist honestly listed `assert_journal_balanced()` as an open item, i.e. **I1 had no database enforcement at all at parse time** (the prior 32/33 probe result) | **Corrected + live-verified** |
| F3 | **Major** | The schema comment / ADR-004 / `DATA_MODEL.md` claimed **byte-identical replay** of the stored response while storing it as `JSONB` — JSONB normalises key order, whitespace and numeric formatting, so the claim was false as written; the replay envelope also adds `replayed: true`, which is itself a byte difference | **Corrected** (semantic replay decided and documented) |
| F4 | **Major** | `DATA_MODEL.md` still presented the superseded PROCESSING/COMPLETED idempotency alternative and a "Decisions still requiring an ADR" list of seven items that are all decided — misleading open-ness | **Corrected** (supersession labels + decision map) |
| F5 | **Critical (for Phase 4)** | `admin_control`'s runtime privilege for the `SELECT … FOR UPDATE` serialisation point was deferred with SELECT-only assumed — **insufficient**: PostgreSQL requires UPDATE privilege on ≥1 column of every table named in a locking clause; without it the ADMIN-002 last-admin guard would fail at runtime with `ERROR: permission denied for table admin_control` | **Decided**: `GRANT SELECT, UPDATE (updated_at) ON admin_control TO ledgerline_app` |
| F6 | **Medium** | I1's written invariant was "Σ debits = Σ credits" only — missing the explicit ≥2-entries and one-consistent-currency clauses the design must enforce (challenge requirement + D-4) | **Corrected** (I1 upgraded in ADR-002 / schema / acceptance) |
| F7 | **Medium (documentation necessity note)** | The lifecycle tables' scoped `UPDATE` grants (sessions/users/account_permissions) were documented as merely permitted — the verified locking-clause privilege rule makes them **necessary** for the money path's `FOR SHARE` reads (sessions, users, grants are all read `FOR SHARE` in the money transaction) | **Corrected** |

No missing required file: all mandated Step-1 sources existed (`docs/ARCHITECTURE.md`, `THREATS.md` at the repo root, all ADR-001…ADR-007, the phase instructions, prior reports `PHASE-03-report.md`/`PHASE-02-REV3-REVIEW-REPORT.md`, skills, agents).

---

## 2. Files inspected

`docs/schema-draft.sql`; `docs/adr/ADR-001-stack-and-layering.md` … `docs/adr/ADR-007-revocation-vs-inflight.md` (all seven); `docs/AUTHZ_MATRIX.md`; `docs/DATA_MODEL.md`; `docs/ACCEPTANCE.md`; `docs/TEST_PLAN.md`; `docs/REFUSAL_CODES.md`; `docs/IDEMPOTENCY_BEHAVIORS.md`; `docs/ARCHITECTURE.md`; `docs/PROPOSED_DEFAULTS.md`; `THREATS.md`; `docs/ROADMAP.md`; `docs/QUALITY_GATES.md`; `phases/PHASE-03-architecture.md`; `docs/reports/PHASE-03-report.md` (+ dated addendum), `docs/reports/PHASE-02-REV3-REVIEW-REPORT.md` (history only, untouched); `.claude/skills/*` (esp. `ledger-posting`, `idempotent-money-command`, `concurrency-test-writing`); `AGENTS.md`, `CLAUDE.md`; `scripts/verify-kit.sh` (source read before execution); `PROMPTS.md` (history, format and honesty rules); repository tree.

## 3. Files modified

`docs/schema-draft.sql`; `docs/adr/ADR-002-ledger-model.md`; `docs/adr/ADR-004-idempotency-and-refusals.md`; `docs/adr/ADR-005-append-only-and-db-roles.md`; `docs/adr/ADR-006-authentication-and-sessions.md`; `docs/AUTHZ_MATRIX.md`; `docs/DATA_MODEL.md`; `docs/PROPOSED_DEFAULTS.md`; `docs/IDEMPOTENCY_BEHAVIORS.md`; `docs/REFUSAL_CODES.md`; `docs/API_CONTRACT.md`; `docs/ACCEPTANCE.md`; `docs/TEST_PLAN.md`; `docs/QUALITY_GATES.md`; `THREATS.md`; `phases/PHASE-06-schema-ledger-core.md`; `phases/PHASE-09-idempotency.md`; `.claude/skills/ledger-posting/SKILL.md`; `.claude/skills/idempotent-money-command/SKILL.md`; `PROMPTS.md` (new dated entry); `docs/reports/PHASE-03-FINAL-GATE-3-REVIEW.md` (this file, new).

Deliberately untouched: all historical reports and `PROMPTS.md` history; ADR-001/003/007 (consistent as found; ADR-007's revocation wording already table-based); every ADR **Status: Proposed**.

## 4. Technical corrections performed

### F1 — Session revocation on one representation (`revoked_at`)
- **Severity/problem:** High — normative authorization text referenced a column that does not exist; any implementation could "choose" the unimplemented one.
- **Root cause:** the §D.3a wording predates the schema-last naming (`revoked_at`, nullable TIMESTAMP, retained for audit) and was never re-swept.
- **Correction:** §D.3a and ADR-006 item 2 now define the single **active-session predicate** — `revoked_at IS NULL AND expires_at > now()` — state explicitly that there is **no session `status` column** and that no normative wording may introduce a second representation; every revocation path (logout, admin revoke, role-change/disable revoke, rotation) is the one statement `UPDATE sessions SET revoked_at = now() [| WHERE …]` taken `FOR UPDATE`, serialising against the money path's `FOR SHARE` session re-read (exactly two legal orders, unchanged). `schema-draft.sql` carries the predicate as a table comment; `AC1.4`, `sessionRevokeRace.test.ts` row and the AUTHZ_MATRIX changelog updated. The 401-outcome law (revoked session ⇒ 401, never 404) was already settled (Rev 4b) and is untouched.
- **Evidence:** schema line comment + ADR-006 item 2 + §D.3a; sweep: zero surviving `SET status = 'REVOKED'` wording (only the changelog's historical description remains); no `sessions.status` anywhere.
- **Remaining risk:** none identified beyond the usual drift risk — future wording must use the predicate (test SESS-001 pins it).

### F2 — Zero-entry journals and full `assert_journal_balanced()` (F6/F7-related I1 upgrade folded in)
- **Severity/problem:** Critical — a POSTED financial journal with zero, one, unbalanced or mixed-currency entries could previously be inserted; the prior real-PostgreSQL parse probe scored 32/33 because the function body did not exist.
- **Root cause:** the original design anchored only on `ledger_entries`; by verified PostgreSQL semantics a trigger cannot fire without a trigger event, so an entry-less journal bypassed enforcement entirely. The draft kept an honest open checklist item rather than pretending.
- **Verification before selection (official docs, verified 2026-11-08):** constraint triggers are AFTER-ROW (`FOR EACH ROW`) only; `DEFERRABLE INITIALLY DEFERRED` fires at transaction end where all transaction changes are visible. Consequence: a deferred trigger anchored on **`journal_transactions`** fires at COMMIT even when the same transaction inserted no entries, and its aggregate over `ledger_entries` sees them when they exist — statement order (journal first, entries after) is irrelevant. Two anchored triggers sharing one read-only aggregate function is therefore the minimal, semantics-safe design; row triggers on journal UPDATE are unnecessary in v1 (journals are insert-only; `status` CHECK keeps exactly `POSTED`).
- **Correction:** `docs/schema-draft.sql` now defines the complete function — dispatch on `TG_TABLE_NAME` (journal row → `NEW.id`; entry → `NEW.journal_transaction_id`), COMMIT-time aggregate with `SUM(amount_minor) FILTER` into `NUMERIC` (`sum(bigint)`→numeric: exact, no overflow), four failure checks (0 entries, 1 entry, unbalanced, currency-mismatch incl. journal-vs-entry), hardened `SET search_path = public, pg_temp`, SECURITY INVOKER — and the two named deferred triggers `journal_transactions_journals_balanced` / `ledger_entries_journals_balanced`. I1 upgraded to Σ debits = Σ credits **and ≥2 entries and one consistent journal currency** everywhere it is cited (ADR-002 item 2, `PROPOSED_DEFAULTS.md`, `PHASE-06` P6.3, `QUALITY_GATES.md`, ledger-posting skill). Rollback/atomicity: any raise inside the deferred phase aborts the whole transaction (verified live, §10). **Accepted residual, disclosed (not hidden):** an out-of-band *balanced* append to an existing POSTED journal is accepted by construction (INSERT-only privileges; the aggregate still sees and allows it) — v1 code never appends to an existing journal; corrections are new compensating journals; recorded as an ADR-002 risk and validated live (§10, probe 9a/9b).
- **Tests registered:** new acceptance ID **JBL-001 ✱** with the exact mandated case set (zero-entry / one-entry / unbalanced / balanced / multi-entry / full-rollback-zero-residue / concurrent / trigger-disable mutation check) in `ACCEPTANCE.md` + `journalBalance.test.ts` in `TEST_PLAN.md`; `THREATS.md` T-013 control cell now names the test; R4's test list updated; mutation-list additions (g)/(h); the exact Phase 4/5 psql recipe (SQLSTATE `P0001` from the RAISE, counts unchanged after aborted COMMIT) documented in ADR-002 Verification.
- **Evidence:** the live probe in §10 (all designed outcomes reproduced on a real cluster).
- **Remaining risk:** the acknowledged balanced-append residual (documented; revisit via H-5 hash chain / Phase 12); in-transaction trigger-disable checks remain Phase 4/5 work.

### F3 — Replay guarantee: semantic, honestly documented
- **Severity/problem:** Major — design text promised byte-identical replay while JSONB stores cannot deliver it; an interviewer catching this would read it as not understanding one's own storage engine.
- **Root cause:** template wording from the pre-JSONB phase; JSONB's normalisation (key order, whitespace, number formatting) unconsidered; `replayed: true` also differs from the first response by construction.
- **Correction:** the guarantee is now **semantic replay of the stored financial outcome** — stored status + identical business field values (money/sequence fields as JSON strings, T-049) + `replayed: true`; byte-identity deliberately not promised; `BYTEA` original-bytes storage evaluated and **not chosen** (duplicate payload, single-response-type benefit, second source of truth; recorded in ADR-004 §1a so the future option is explicit for the human). Held constant: at-most-one-effect-per-scoped-key; replay re-evaluation gate 401/404/409 evaluation-only (no writes, no counter bump, no attempt rows); same-key concurrency serialised by the unique constraint, no PROCESSING state. Surfaces updated: schema comment, ADR-004 §1a + step 7 + IDEM-001 verification, DATA_MODEL, IDEMPOTENCY_BEHAVIORS row 4, REFUSAL_CODES §3, API_CONTRACT, ACCEPTANCE (IDEM-001/AC6.2), TEST_PLAN, PHASE-09 P9.1, skill step 7.
- **Evidence:** corrupt-free sweep; every remaining "byte-identical" string is a deliberate not-chosen/superseded note; ADR-004 §4 kept unrenumbered (cross-references intact).
- **Remaining risk:** none material; if the human ever requires byte-identical replay it is a new ADR (documented as such).

### F4 — Stale DATA_MODEL decisions
- **Severity/problem:** Major — the doc implied decisions were open when ADRs decide them (misleading for a reviewer deciding Gate 3).
- **Root cause:** phase-2 candidate text never re-aligned when ADR-002/004 were drafted.
- **Correction:** processed in place, labelled not deleted: journal `status` = exactly `POSTED` (refusals are never journal rows); signed-delta superseded in favour of `direction` DEBIT/CREDIT; PROCESSING/COMPLETED superseded with the rationale (no-PROCESSING atomic claim; aborted transaction leaves no key row; concurrent duplicates serialise on the unique constraint); byte-identical paragraph replaced by the semantic block; "Decisions still requiring an ADR" → decision status map items 1–7 with pointers; **genuine open items preserved** in an honest "still open / awaiting the human" bullet (all ADRs Proposed until acceptance; H-5 deferral; v2 replay-accounting opt-in). Header note states the normative authority is the ADR + schema draft.
- **Evidence:** per-item re-read; the one self-caught contradiction (my first journal-status edit said `POSTED, REFUSED`) found and corrected on the re-read *before* the sweep — recorded in PROMPTS.md.
- **Remaining risk:** none — the map is pointer-based so future ADR changes have a fixed place to update.

### F5/F7 — Privilege boundaries decided (admin_control + locking-clause rule + accounts recheck)
- **Severity/problem:** Critical for Phase 4 — SELECT-only would make `SELECT … FOR UPDATE` fail at runtime, breaking ADMIN-002; anything stronger (table-level UPDATE) would widen the runtime surface.
- **Verification before decision (official SELECT reference, verified 2026-11-08):** a locking clause requires the UPDATE privilege on at least one column of every table named in that clause; `FOR SHARE` and `FOR UPDATE` are symmetric in this respect. Two derived facts: (a) the admin serialisation point cannot work with SELECT-only; (b) the money path's `FOR SHARE` reads on sessions/users/grants need the *existing* scoped UPDATE grants — they are necessary, not incidental, now documented as such.
- **Correction (AI-recommended, human-overridable):** `GRANT SELECT, UPDATE (updated_at) ON admin_control TO ledgerline_app` — minimal grant satisfying the rule; `updated_at` is the only column admin lifecycle touches under the lock (a harmless audit touch; `id` immutable via `CHECK (id = 1)`; no DELETE/TRUNCATE exists anywhere). **FOR SHARE rejected on verified conflict semantics**, not taste: share locks do not conflict with share locks, so two concurrent demotions would both proceed and ADMIN-002's zero-admin outcome becomes possible. **SECURITY DEFINER lock function considered and not chosen** — same objections as the accounts decision (extra in-path hop, hidden write, ownership/`search_path` review burden); recorded so the human can override. Alternatives evaluated and rejected: running the lifecycle as the owner role (contradicts role separation), a second lock table (unnecessary). Accounts boundary rechecked unchanged: column-level `UPDATE (balance_minor, event_last_seq, updated_at, status)`; its column-list incidentally satisfies the locking rule for the posting path's `FOR UPDATE` — noted. Surfaces: ADR-005 item 2 + new boundary tests (FOR UPDATE succeeds and two sessions serialise; `UPDATE admin_control SET id=…` fails; DELETE/TRUNCATE fail; same-privilege coverage for the FOR SHARE lifecycle reads), AUTHZ_MATRIX §C.2 + changelog, schema grants block, TEST_PLAN mutation (g).
- **Evidence:** doc-verified rule; the design is consistent across all surfaces (sweep).
- **Remaining risk:** the boundary tests themselves are Phase 4/5 work (roles not created in the scratch probe); human may override the grant choice at Gate 3 with no design change beyond the GRANT lines.

## 5. Architectural decisions recommended
(all AI-recommended, all recorded with alternatives + trade-offs, **none marked Accepted**; ADRs stay Proposed)

1. **Semantic replay guarantee** (ADR-004 §1a) — semantic replay promised; byte-identical explicitly not claimed; BYTEA storage considered-not-chosen for the human's future discretion.
2. **Admin serialisation privilege = `SELECT, UPDATE (updated_at) ON admin_control`** (ADR-005 item 2 + §C.2) — minimal verified-sufficient grant; FOR SHARE and SECURITY DEFINER rejected with recorded reasons.
3. **Two deferred constraint triggers sharing `assert_journal_balanced()`** (ADR-002 + schema) — the only design that catches zero-entry journals given verified trigger semantics; balanced-append residual disclosed.
4. **Locking-clause privilege rule made explicit** for the lifecycle tables (ADR-005 + grants block) — turns incidental wording into a documented necessity.

## 6. Unresolved decisions
No silently resolved ambiguity; the four recommendations above await human approval/override. Additionally open by design: H-1 and H-4 (human tasks), H-5 deferral, Docker/host choices in Phase 4, CONFIG pacing, v2 replay accounting opt-in. The draft's only remaining open checklist item is the syntax-polish pass before migration conversion.

## 7. Security implications
- Positive: admin-lifecycle serialisation now provably workable under least privilege; the uniform-404/TIMING-001 envelope, append-only, T-049 string serialisation, and all previously approved postures were re-swept and stand unchanged; no privilege widened beyond the minimal column needed for `FOR UPDATE`; `updated_at` write cannot bypass `CHECK (id = 1)`.
- Negative/risks: none new; the accepted residuals (hostile superuser/T-026 disclosure, T-050 operator-id attribution claim, non-monotonic operator hazard families T-041/T-042) remain as previously recorded.

## 8. Database integrity implications
- Positive: I1 gains a real COMMIT-time enforcement layer validated against a live PostgreSQL server — the financial core (per-journal conservation incl. zero-entry rejection, currency consistency) is now enforceable at the database layer, not only in code; rollback/atomicity behaviour verified.
- Negative/risks: deferred-trigger failure surfaces at COMMIT (a rejected transaction pays its full lock cost before failing) — accepted trade-off; the duplicate per-journal evaluation at commits with many entries is a cheap read-only aggregate over final row versions (documented); the balanced-append residual is documented (§4/F2).

## 9. Test coverage added to the plan
- **JBL-001 ✱** (ACCEPTANCE register + `journalBalance.test.ts` in TEST_PLAN): zero-entry rejected at COMMIT; one-entry rejected; unbalanced rejected; balanced two-entry/multi-entry commit; currency-mismatch rejected; every rejection leaves zero journal/entry/attempt/balance rows; concurrency variant (parallel balanced journals); trigger-disable mutation check.
- Two new mutation forms (g)/(h) (ADMIN-002 must fail under `FOR SHARE` substitution; JBL-001 must fail when triggers are disabled).
- Exact psql sequence (SQLSTATE `P0001` from the function's RAISE, count assertions after each aborted COMMIT) documented as the Phase 4/5 integration recipe, alongside this review's §10 probe results.
- Session-predicate wording updates in AC1.4 / SESS-001's `sessionRevokeRace.test.ts` row; R4 test-list refresh; ADR-002 Verification expanded with the JBL-001 recipe and the T-013 control cell updated in `THREATS.md`.

## 10. Verification commands and actual results

### `scripts/verify-kit.sh` (inspected before run — what it verifies)
It is a documentation-lint: doc path references exist; PHASE-00–15 phase files present; skill/agent frontmatter and names match; phase-declared skills exist; threat IDs referenced by files exist in `THREATS.md`; a stale-technology-reference check; a secret-pattern scan. **It does not run application or database tests** — none exist, and it is explicitly not described as one.

**Actual result:** `kit OK` after all edits and again after the report was written.

### Real-PostgreSQL probe — disposable scratch cluster (native `initdb`, trust auth, 127.0.0.1:**5433**; the human's PostgreSQL service on **5432 was never connected to or modified**; clean-room scratch DB `kitprobe`; scratch datadir/log/script deleted afterwards; port 5433 verified closed)

| # | Probe | Expected | Actual |
|---|---|---|---|
| 0 | Full `docs/schema-draft.sql` with `ON_ERROR_STOP=1` | all statements apply (prior pass: 32/33) | **zero errors** — the 33rd statement (`assert_journal_balanced()`) applies; catalogue: 10 tables, 2 constraint triggers, 8 non-internal append-only triggers, 2 functions |
| 1 | zero-entry journal; `COMMIT` | rejection at COMMIT; counts 0/0 | **`ERROR: journal 1 is empty (0 entries); a POSTED journal requires >= 2 entries`** · journal=0 entries=0 |
| 2 | one-entry journal | rejection, no residue | `journal 2 has 1 entry …` · journal=0 |
| 3 | unbalanced 5000/4000 | rejection, no residue | `journal 3 is unbalanced: debits 5000 <> credits 4000` · journal=0 |
| 4 | balanced two-entry | commit | COMMIT success · journal=1 entries=2 |
| 5 | currency mismatch (INR/USD) | rejection, no residue | `journal 5 has inconsistent entry currencies (journal currency: INR, distinct entry currencies: 2)` · journal=1 |
| 6 | balanced four-entry | commit | journal=2 entries=6 |
| 7 | mid-tx `ROLLBACK` | zero residue | journal=2 entries=6 (unchanged) |
| 8 | two parallel sessions, each one balanced journal | both commit, I1 holds | journal=4 entries=10 |
| 9a | out-of-band **balanced** append to an existing POSTED journal | accepted (documented residual) | accepted · entries 10→12 |
| 9b | out-of-band **unbalanced** append | rejected | `journal 9 is unbalanced: debits 322 <> credits 272` · counts unchanged |

**Not run (and not claimable):** role-privilege boundary tests (the grants block is commented; scratch cluster ran as superuser, so `FOR SHARE`-without-UPDATE would not have failed there realistically); same-key idempotency races via real request path; Vitest/Playwright suites (no code exists).

### Exact commands recorded for Phase 4/5 (from ADR-002 Verification)
- Rejection cases: `psql -v ON_ERROR_STOP=1 -c "BEGIN; INSERT INTO journal_transactions …; <entries>; COMMIT;"` → expect SQLSTATE **P0001** (`raise_exception`) at COMMIT, then `SELECT count(*) FROM journal_transactions / ledger_entries` unchanged.
- Privilege boundary: as `ledgerline_app`, `SELECT … FOR UPDATE` on `admin_control` (must succeed and serialise), `UPDATE` other tables/columns as designed, `FOR SHARE` without UPDATE anywhere → must fail with the privilege error.

## 11. Limitations of verification
- The probe validated **schema mechanics** (parseability of the full draft + trigger semantics), not application behaviour, endpoints, or the phrase-level TypeScript path — no code exists yet.
- The scratch cluster ran as superuser with trust auth, with the grants block deliberately unapplied — the design-guard tests (role privilege denial) and the two-role split remain Phase 4/5 work on the real migration when H-4 host-role facts are known.
- The concurrency probe used two parallel psql sessions (real row locking); the acceptance plan's JBL-001/Vitest, backend/full-stack harnesses remain unimplemented by scope.
- Windows/WSL interop forced tooling workarounds (documented in `PROMPTS.md`); no repository content was affected.
- No web/app server, no npm scripts, no secret store in scope.

## 12. Human approval still required
1. Accept or override the four §5 AI-recommended decisions (esp. the `admin_control` grant — an alternative chose `SECURITY DEFINER` lock function also recorded).
2. Accept each ADR as `Accepted` at Gate 3 (status currently `Proposed` in all seven).
3. H-1 (placement-cell timing) and H-4 (host DB-role verification) still open; `assertGlobalInvariants` naming pair and closing approvals already human-flat-approved in the Gate 2 record — no change requested.
4. Approve the journal-balance design in its chosen two-trigger shape (Behaviour probe results above may be cited in the acceptance decision).
5. The Git commits (commit links left blank in `PROMPTS.md`).

## 13. Final GO / NO-GO recommendation for Phase 4

The Gate 3 acceptance conditions are checked one by one:

| Condition | Met? |
|---|---|
| All critical schema/design contradictions resolved | ✅ (F1..F5 all registered and closed; sweeps clean) |
| ADRs agree with the schema and requirements | ✅ (ADR↔schema↔AUTHZ/ACCEPTANCE re-swept; no orphan wording) |
| Journal-balance design protects zero-entry journals | ✅ designed **and live-verified** (probe 1) |
| Replay guarantees accurately documented | ✅ semantic guarantee everywhere; no surviving byte-identical normative claim |
| Session revocation uses one representation | ✅ `revoked_at` predicate only; no `status` column exists or is referenced |
| Runtime database privileges explicitly resolved | ✅ every grant line and denial documented; the one previously-deferred decision (admin_control) is decided |
| Acceptance criteria and planned tests cover the invariants | ✅ JBL-001 ✱ registered with the full mandated case set; mutation list extended |
| No critical unresolved design issue remains | ✅ remaining items are human approvals/human tasks or implementation-phase checks, not design gaps |

### Recommendation: **GO for Phase 4 — conditional on the human's Gate 3 acceptance**

- Technically the design is consistent, implementation-ready under the agreed v1 scope, and the four risk-critical decisions now each carry evidence instead of deferral.
- The GO takes effect only when the human approves the four §5 decisions and marks the ADRs `Accepted`; **until then every ADR stays `Proposed`, and nothing of Phase 4 (code, migrations, endpoints, scaffolding) has been started by this task** — none exists, and no test executes against pseudo-code.
- If the human overrides any recommendation (e.g., byte-identical replay or SECURITY DEFINER on `admin_control`), the affected surfaces are already mapped (ADR-004 §1a / ADR-005 item 2 + grants block) and changes stay local — no structural rework is implied.

No further corrections are known to the reviewer; the kit's documentation-lint passes, the schema draft now parses and applies 100% on a real PostgreSQL engine, and every required invariant has a designed enforcement layer, a named planned test, and an honest residual-risk note where one exists.
