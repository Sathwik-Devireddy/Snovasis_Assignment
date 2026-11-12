# Phase Report — Phase 2: Requirements, roles and threat model

- **Date:** 2026-11-06
- **Agent:** 01 product analyst + 07 security reviewer + 08 QA (run by OpenCode/GLM)
- **Status:** Rev 1 (Gate 2 feedback applied 2026-11-06) — **Gate 2 still NOT approved; awaiting human re-review**
- **Scope:** P2.1–P2.7 (+ Rev 1 revision of P2.2/P2.3 deliverables)

## Revision history

### Rev 1 — 2026-11-06 (Gate 2 review feedback)

Applied the human reviewer's five feedback items exactly; **no application code, dependencies or migrations were touched**; Gate 2 left unapproved.

| # | Feedback | Change made |
|---|---|---|
| 1 | Admin external withdrawals restricted to active CUSTOMER accounts | `AUTHZ_MATRIX.md` §A (DEPOSIT/WITHDRAW rows now say "any active CUSTOMER account"); `ACCEPTANCE.md` AC3.1–AC3.3 |
| 2 | Secure initial administrator provisioning | `AUTHZ_MATRIX.md` §C.1 (out-of-band single-run bootstrap, host-generated password, audit event, no self-registration, bootstrap ≠ demo seed) |
| 3 | Last active admin cannot be removed/demoted | `AUTHZ_MATRIX.md` §C.2 (same-transaction count guard, race-free); reason `LAST_ADMIN_PROTECTED` (REFUSAL_CODES §3); **test ADMIN-001**; **threat T-045** |
| 4 | Role-change/session-revocation during in-flight transactions | `AUTHZ_MATRIX.md` §D (`users` row `FOR UPDATE` vs command's `FOR SHARE`; exactly two legal orders; changed user's sessions revoked in same tx; idempotency replay still re-authorises); **test ROLE-001**; **threat T-046** |
| 5 | REFUSAL_CODES consistency | `LOCK_TIMEOUT` now records a rate-limited **FAILED** attempt row (infra class, never statement-visible); `VALIDATION_*` wildcard removed → defined `VALIDATION_FAILED`/`UNAUTHENTICATED`/`RATE_LIMITED`; formal shape-vs-value boundary (§2); `account_seq` (postings) vs `attempt_seq` (attempts) allocation defined (§5); `FORBIDDEN`≡`ACCOUNT_NOT_FOUND` single 404 envelope with truth kept internally (§0/§3) |
| — | A8 visibility policy preserved | `REFUSAL_CODES.md` §6 — unchanged in substance, holders see refusals targeting their accounts only, no payloads/unmeasured balances; `DISCOVERY.md` A8 marked resolved; T-020 verification now names AUTH-007 |

Updated in step: `docs/ACCEPTANCE.md` (AC1.5/1.6, AC9.4/9.5, AC3 rows, register + ADMIN-001/ROLE-001), `docs/TEST_PLAN.md` (`roleChangeRace`, `userLifecycle`, updated crossUser/amounts/statements/seedIdempotency/accounts rows), `THREATS.md` (T-045, T-046, T-020), `PROMPTS.md` (dated entry — the 403/404 existence-leak was a genuine Rev-0 defect caught by this review).

**Human gate status (unchanged, nothing auto-approved):**
- [ ] Approve Rev 1 `docs/AUTHZ_MATRIX.md` (§A/§C/§D).
- [ ] Approve Rev 1 `docs/REFUSAL_CODES.md` (esp. §2 boundary, §5 sequences, uniform 404 envelope).
- [ ] Confirm the A8 policy statement as preserved.

### Rev 2 — 2026-11-07 (Gate 2 final technical corrections)

Applied all four findings + two clarifications; **no application code, dependencies, migrations, or git operations**; Gate 2 still unapproved.

| # | Finding / clarification | Change made |
|---|---|---|
| 1 | ADMIN-002 last-admin concurrency | `AUTHZ_MATRIX.md` §C.2 rewritten: dedicated **`admin_control` singleton row `FOR UPDATE`** serialises every count-reducing admin operation (two concurrent demotions of different admins can no longer both proceed — the loser re-counts after the winner commits and refuses with `LAST_ADMIN_PROTECTED`); lock order defined (§D.6); **real race test ADMIN-002**; new threat **T-047** |
| 2 | AUTH-009 nonexistent-account audit | `REFUSAL_CODES.md` §5: `ACCOUNT_NOT_FOUND` rows persist with **NULL** account FK/`attempt_seq`/balance, verbatim `supplied_account_ref` (text, not FK), exact internal reason; uniform external 404 unchanged; **persistence test AUTH-009** |
| 3 | INVALID_AMOUNT balance contradiction | §2 canonical validation order (pre-lock vs under-lock phases) + §4 **balance-availability matrix**: `INVALID_AMOUNT`, `CURRENCY_MISMATCH`, `SAME_ACCOUNT`, `SYSTEM_ACCOUNT_NOT_ALLOWED` → `balance_at_attempt_minor = NULL`; only `INSUFFICIENT_FUNDS`/`ACCOUNT_NOT_ACTIVE` (read under lock) carry balances |
| 4 | Infrastructure audit sequencing | §3 + §5: FAILED rows are **best-effort**, written by a transaction touching only the attempt table + a dedicated **non-transactional `global_seq` SEQUENCE** (no row locks → no contention or deadlock during lock-timeout recovery); per-actor rate limit (T-042); audit failure never changes the response |
| C1 | Session-row locking & revocation linearisation | `AUTHZ_MATRIX.md` §D.3a: money command re-reads its session row `FOR SHARE` **inside** the transaction (authenticity is in-transaction, not just HTTP-layer); revocation takes `FOR UPDATE`; two legal orders; post-revocation calls 401; **test SESS-001**; threat **T-048**; global lock order now `admin_control → sessions → users → grants → idempotency → customer accounts` |
| C2 | Bootstrap `--override` safeguards | §C.1.3: mandatory `--operator <id>` (audited verbatim), exact typed `--confirm` phrase, CI-context refusal by default, distinct `bootstrap_override` audit event, same-transaction session revocation |

Updated in step: `docs/ACCEPTANCE.md` (register + ADMIN-002/SESS-001/AUTH-009; AC1.5/1.6, AC8.2, AC9.5–AC9.7; INV-001 scoped to allocated sequences; STMT-002 merge contract), `docs/TEST_PLAN.md` (+`lastAdminRace`, +`sessionRevokeRace`; `attempts`, `invariants`, `userLifecycle` rows; mutation checks (e)/(f)), `THREATS.md` (+T-047, +T-048; T-045/T-046 refined), `docs/IDEMPOTENCY_BEHAVIORS.md` (row 7 session-revocation), `PROMPTS.md` (dated 2026-11-07 entry recording that the Rev-1 last-admin rule was genuinely racy and the single-counter sequencing failed for nonexistent accounts).

**Human gate status (Rev 2, nothing auto-approved):**
- [ ] Approve Rev 2 `docs/AUTHZ_MATRIX.md` (§C.2 serialization, §D.3a session linearisation, §D.6 lock order).
- [ ] Approve Rev 2 `docs/REFUSAL_CODES.md` (§4 balance matrix, §5 two-tier sequencing, AUTH-009 model).
- [ ] Confirm A8 §6 statement (unchanged from Rev 1).

## Original Rev 0 record (superseded content kept for honest history)

## Objective

Make every requirement testable and the threat list complete **before design**. No code.

## Repository facts and assumptions

- Fact: kit-only repo (Phase 1 finding); `THREATS.md` started at T-001..T-042, all OPEN; no code exists to test against.
- Assumption: test-ID registry in `docs/ACCEPTANCE.md` is treated as canonical and will be mirrored by actual test files from Phase 4 onward.

## Work performed

| Task | Outcome | File(s) |
|---|---|---|
| P2.1 | Acceptance criteria for all 10 requirements + canonical test-ID register (34 IDs incl. 7 new ✱) | `docs/ACCEPTANCE.md` |
| P2.2 | Authorisation matrix: role × action × account grant, admin cash-desk vs transfer distinction, self-grant ban, ADR-007 revocation rule referenced | `docs/AUTHZ_MATRIX.md` |
| P2.3 | Closed-list refusal taxonomy (4 classes, 11 codes), what is/never recorded, statement-visibility rules | `docs/REFUSAL_CODES.md` |
| P2.4 | Idempotency behaviour table (11 scenarios incl. in-flight, replayed refusal, infra failure), hashing + retention | `docs/IDEMPOTENCY_BEHAVIORS.md` |
| P2.5 | Attack-path review of T-001..T-042: two gaps found and added as T-043 (SYSTEM-account destination) and T-044 (seed double-run), each with a test ID | `THREATS.md` |
| P2.6 | Test-file list (unit/integration/concurrency/api) each mapped to threat + test IDs; mutation-check list; `assertGlobalInvariants` standing rule | `docs/TEST_PLAN.md` |
| P2.7 | Explicit non-goals list with reasons | `docs/NON_GOALS.md` |
| — | Dated AI-use entry drafted for the human to commit | `PROMPTS.md` |

## Files changed

| File | Change | Reason |
|---|---|---|
| `docs/ACCEPTANCE.md` | New | P2.1 |
| `docs/AUTHZ_MATRIX.md` | New | P2.2 |
| `docs/REFUSAL_CODES.md` | New | P2.3 |
| `docs/IDEMPOTENCY_BEHAVIORS.md` | New | P2.4 |
| `THREATS.md` | Appended T-043, T-044 (OPEN) | P2.5 |
| `docs/TEST_PLAN.md` | New | P2.6 |
| `docs/NON_GOALS.md` | New | P2.7 |
| `PROMPTS.md` | Added dated entry | AGENTS.md AI-review contract |
| `docs/reports/PHASE-01-report.md`, `docs/reports/PHASE-02-report.md` | New | Phase-report template |

## Verification

- Commands run: test-ID consistency checks performed by reading both source docs (`QUALITY_GATES.md`, `THREATS.md`) and cross-referencing every referenced ID; grep confirmed threat table now ends at T-044 and no orphan IDs remain in docs.
- Test results: none — docs-only phase (no tests exist by design; first test runs in Phase 4).
- Manual checks: authorisation matrix manually reconciled against the brief's role table row by row (admin cannot self-grant or transfer without grant; auditor zero writes; holder grant-scoped).

## Acceptance criteria (Gate 2)

- [x] Every requirement has testable criteria mapped to test IDs.
- [x] Every threat (T-001..T-044) has a test ID or an explicitly approved live-check.
- [ ] **Human has approved the authorisation matrix** — requested `docs/AUTHZ_MATRIX.md` for review first; pending.
- [ ] **Deposit policy approved** as part of matrix review (H-2 already answered: admin-only).
- [x] Refusal taxonomy and idempotency behaviour defined before implementation.
- [x] Non-goals list written.

## Risks / incomplete work

- **A8 (FORBIDDEN-refusal statement visibility)** — preserved as policy in Rev 1 (see revision history); the Rev-0 note below was superseded. _(Rev 0: proposal pending Gate 2 review.)_
- **Holder-own-session-events view** and **admin can't change own role** in the matrix are marked as proposed defaults — human may alter them.
- Test IDs ✱ (AMT/RET/INF/LOG/LOAD/DEST/SEED) need to be adopted into the pack's QUALITY_GATES table or live only in `ACCEPTANCE.md` — deliberate: kept additive without editing the kit's original table.
- H-1 (repo-public timing) and Gate 0 remain outstanding human tasks; they block Phase 4 deploy work if unresolved.

## AI review record

- Self-corrections during review are recorded in the dated `PROMPTS.md` entry (T-043/T-044 discovery, matrix row clarification).
- No fabricated evidence: every claim in these docs is a design statement or a recorded human answer, not a verified runtime fact.

## Suggested commit

`docs: gate 2 rev 2 — admin-control serialization, audit sequencing and nonexistent-account audit model`

## Human decision required

1. Approve `docs/AUTHZ_MATRIX.md` (or request edits) → completes Gate 2.
2. Confirm A8 refusal-visibility default.
3. (Outstanding) H-1 placement-cell question; Gate 0 portal tasks.
