# Phase 2 — Rev 3 Review Report (Gate 2 documentation corrections)

- **Date:** 2026-11-07
- **Scope:** Documentation-only correction of nine Rev 3 findings. **No application code, no dependencies, no migrations, no Git operations, no Phase 3 work.**
- **Gate 2 status:** **NOT approved** — this report and the revised documents are returned for human review.
- Documents revised in this round: `docs/AUTHZ_MATRIX.md` (Rev 3), `docs/REFUSAL_CODES.md` (Rev 3), `docs/ACCEPTANCE.md`, `docs/TEST_PLAN.md`, `THREATS.md`, `PROMPTS.md` (new entry). Test IDs and threat references updated consistently.

---

## 1. Finding-by-finding resolutions

### Finding 1 — Lock-order consistency
**Problem:** Rev 2's §D implied the role-change transaction could take the target `users` row `FOR UPDATE` before the session rows, while §D.6 declared `sessions → users` — an internal conflict; and the claimed single "global chain" mixed money-path and admin-lifecycle locks in a way that could never happen in one transaction.

**Resolution:** two explicitly documented, cycle-free lock paths (`AUTHZ_MATRIX.md` §D.6):
- **Money path:** actor's session row (`FOR SHARE`) → actor's `users` row (`FOR SHARE`) → grant rows (`FOR SHARE`, ascending id) → idempotency row → customer account rows (`FOR UPDATE`, ascending id).
- **Admin-lifecycle path:** `admin_control` row (`FOR UPDATE` — **only when count-reducing**, unchanged from Rev 2) → target's **session rows (`FOR UPDATE`, ascending id, all of them)** → target's `users` row (`FOR UPDATE`), and nothing beyond.

§D item 2 and §C.2 were rewritten to state sessions-before-users explicitly; T-046's control text updated to match. (See also cross-check #4 below.)

**Changed sections:** `AUTHZ_MATRIX.md` §C.2 (lock-order bullet), §D item 2, §D.6, §E map (Rev 3 table); `THREATS.md` T-046; `ACCEPTANCE.md` AC7.2 (finding 6 overlaps); `TEST_PLAN.md` `roleChangeRace.test.ts` unchanged in scope, `lastAdminRace`/`sessionRevokeRace` unchanged.

### Finding 2 — Statement event ordering
**Problem:** The Rev 1/2 "single merged list ordered by `(occurred_at, global_seq)`" could not claim a total order for rows recorded *outside* the account lock, and Rev 2's separate `attempt_seq` counter duplicated per-account sequencing.

**Resolution (`REFUSAL_CODES.md` §5, superseding Rev 2 §5):**
- **One shared per-account counter — `accounts.event_last_seq`** — gap-free, monotonic, allocated **only under the account's `FOR UPDATE` row lock** in the money transaction.
  - Ledger postings stamp it as `ledger_entries.account_seq` (column name kept for D-5 continuity — "`account_seq` kept" satisfied);
  - business refusals recorded inside the same locked transaction stamp it as `transaction_attempts.event_seq`;
  - both consume one namespace, values never collide, so a locked refusal has a well-defined position in the account's event stream.
- **Unsequenced rows** (pre-lock business refusals, `FORBIDDEN`/`ACCOUNT_NOT_FOUND`, `FAILED`, nonexistent-account rows): `event_seq = NULL`, `balance_at_attempt_minor = NULL`; nonexistent rows additionally have NULL account FK + verbatim `supplied_account_ref` (AUTH-009 unchanged).
- **Statement rendering — exact rule:** the statement returns **two ordered lists**: `events` (postings + locked refusals, ordered by the shared `account_event_seq`, running balance from postings only) and `attempts` (unsequenced targeting rows, flagged `event_position: null`, ordered by `(occurred_at, global_seq)`). `FAILED` rows never appear. Deterministic, reproducible, and honest — no fabricated interleave.
- `global_seq` retained as the contention-free, non-transactional SEQUENCE tiebreak for unsequenced rows and admin audit views (contention analysis from Rev 2 unchanged).

**Changed sections:** `REFUSAL_CODES.md` §5 (rewritten), §1/§3 wording, §6 render note; `ACCEPTANCE.md` register STMT-001, STMT-002, INV-001 (+ AC8.2/AC8.3); `TEST_PLAN.md` `attempts`/`invariants`/`statements.api` rows; `THREATS.md` T-033.

### Finding 3 — Business-refusal wording
**Problem:** `REFUSAL_CODES.md` §1's business-refusal row said "balance was read under the account lock", implying every business refusal has one — contradicting §2/§4 (pre-lock codes: NULL).

**Resolution:** §1 reworded: the balance is stored *"only where the refusal's check ran after the balance was actually read under the account lock — pre-lock business refusals carry NULL (§4 is authoritative; §2's canonical order defines which codes are pre-lock)."* The per-code matrix in §4 is retained unchanged.

**Changed sections:** `REFUSAL_CODES.md` §1 only (plus consistency wording in §3 cells that already referred to §4).

### Finding 4 — SYSTEM destination information disclosure
**Problem:** `SYSTEM_ACCOUNT_NOT_ALLOWED` (409) disclosed the destination's existence and kind to a caller who cannot view the account, while absent/non-permitted destinations return a uniform 404 — an inference channel.

**Resolution:** a **target-visibility rule** (new in `REFUSAL_CODES.md` §3): an error about an account the caller cannot view — the normal case for a transfer *destination* — returns the **uniform 404 `ACCOUNT_NOT_FOUND` envelope**, whether the account is absent, forbidden, closed, suspended, or of kind SYSTEM (VISIBILITY rule covers `SYSTEM_ACCOUNT_NOT_ALLOWED`, destination-`ACCOUNT_NOT_ACTIVE`, `FORBIDDEN`, `ACCOUNT_NOT_FOUND`). Granular 409 target codes are issued **only to account-visible callers** (e.g. an ADMIN depositing into a SYSTEM account gets the true 409 — admins must know why their cash-desk operation failed). Internal attempt rows always keep the exact reason. External status/body remain identically shaped for all the folded cases.

**Tests added/updated:** `TEST_PLAN.md` — `destinationChecks.test.ts` (internal reasons per caller class) and `crossUser.api.test.ts` (uniform envelope + no classification leak); `ACCEPTANCE.md` DEST-001 rewritten, AUTH-007 extended, new AC9.8; T-020/T-040 control text sharpened.

### Finding 5 — Account status enum
**Problem:** `SUSPENDED` appeared in prose but was never defined; `ACTIVE`/`CLOSED` transitions and money rules lived in fragments.

**Resolution:** new **`AUTHZ_MATRIX.md` §F — Account status lifecycle**: enum exactly `ACTIVE` / `SUSPENDED` / `CLOSED` (**SUSPENDED exists** — temporary hold, resumable); transitions all admin-only and audited (`ACTIVE→SUSPENDED`, `SUSPENDED→ACTIVE`, `ACTIVE→CLOSED` and `SUSPENDED→CLOSED` **only at zero balance** — refused otherwise with the new code `NONZERO_BALANCE` (409, admin-lifecycle refusal recorded as an *audit event*, not an `transaction_attempts` row); `CLOSED` is terminal — reopen never possible, new account instead); money operations require `ACTIVE` on source and destination, checked under locks; internal rows record `account_status_detail` (`SUSPENDED`/`CLOSED`); SYSTEM accounts are schema constants outside this lifecycle.

**Changed sections:** `AUTHZ_MATRIX.md` §F (new), §B row pointer; `REFUSAL_CODES.md` §3 (admin-lifecycle table + `NONZERO_BALANCE`, `account_status_detail` field rule §4); `ACCEPTANCE.md` AC2.4, AC9.8-relevant wording; `TEST_PLAN.md` `accounts.test.ts`.

### Finding 6 — Lock-order acceptance criteria (AC7.2)
**Problem:** AC7.2 still listed the stale order `grants → idempotency row → accounts` and didn't distinguish the two paths.

**Resolution:** `ACCEPTANCE.md` AC7.2 now states both full paths verbatim from `AUTHZ_MATRIX.md` §D.6, marks `admin_control` as the first lock for count-reducing admin operations *only*, and explicitly separates the money path from the admin-lifecycle path. AC7.3/AC7.4 link retained; tests row extended (ROLE-001, SESS-001, ADMIN-002).

### Finding 7 — Bootstrap operator identity
**Problem:** `--operator <id>` as an argv value was implicitly treated as identity proof.

**Resolution:** `AUTHZ_MATRIX.md` §C.1.3 redefined: the operator id must come from the **trusted host environment** (`LEDGERLINE_OPERATOR_ID` injected by the deployment tooling in the trusted operator session); a CLI-only value is **refused**; the audit event records the env-derived id **plus the invocation context** observed by the runtime (host/user session), honestly labelled a **claim** — person-level identity verification is out of scope for v1 and disclosed. Runtime environment = the same documented deployment context holding the DB credentials; re-hosting requires an explicit runbook flag. `AC1.5` and the `userLifecycle.api.test.ts` row updated accordingly.

### Finding 8 — Uniform response timing
**Problem:** "uniform endpoint latency profile ... kept uniform" was an absolute latency promise — undefendable.

**Resolution:** identical **status/body** remain hard requirements; latency is now a **mitigation + statistical test** claim: single code path, no case-dependent early-exit or DB round-trip differences, verified by new **TIMING-001** (`timing.api.test.ts`): fixed sample (e.g. 200 calls) across three cases (exists+forbidden / exists+invisible / absent), asserting a documented tolerance (median-difference bound, no consistent monotonic signal). `REFUSAL_CODES.md` §0 reworded; the closing PROMPTS entry notes the removed promise.

### Finding 9 — Unsafe JSON integer handling (new threat T-049)
**Problem:** Nothing defined how JSON integers are parsed; `JSON.parse` → `Number` rounds 17+ digit tokens silently, potentially into *valid* amounts.

**Resolution:** `REFUSAL_CODES.md` §2 integer-precision rules:
1. money fields validated against the **raw JSON token** (grammar `-?(0|[1-9][0-9]*)`; no decimals, exponents, `+`, string variants) — else `VALIDATION_FAILED` (400);
2. conversion straight to `BigInt(tokenString)` — **the money path never converts an amount via `Number`**, so an out-of-range token cannot silently round into a valid one;
3. tokens beyond the signed 64-bit BIGINT range (`> 2^63−1`) are malformed for the domain type → `VALIDATION_FAILED` (400);
4. every money field in **responses** is serialised as a **JSON string** (documented convention).

New threat **T-049**; `ACCEPTANCE.md` AC3.5 + AMT-001 rewritten; `TEST_PLAN.md` rows for `money.test.ts`, `validation/amount.test.ts`, `amounts.api.test.ts` updated.

---

## 2. Test IDs added or changed

| ID | Change | Reason |
|---|---|---|
| `TIMING-001` ✱ | **Added** (api layer) | Finding 8 — statistical timing check of the uniform envelope |
| `STMT-001` | Rewritten | Finding 2 — shared `account_event_seq`, gap-free, running balance from postings |
| `STMT-002` | Rewritten | Finding 2 — two-part render, unsequenced attempts flagged `event_position: null` |
| `INV-001` | Rewritten | Finding 2 — gap-freeness over the **union** of shared-counter consumers |
| `AMT-001` | Rewritten | Finding 9 — raw-token grammar, 64-bit bound, string serialisation |
| `AUTH-007` | Extended | Finding 4/8 — no classification leak; statistical timing reference |
| `DEST-001` | Rewritten | Finding 4 — internal exact reason; external visibility rule |
| `AUTH-009` | Wording only | `attempt_seq` → `event_seq` naming (no semantic change) |
| (new `timing.api.test.ts`) | **Added** to TEST_PLAN | Hosts TIMING-001 |
| Threat IDs | T-049 **added**; T-033/T-020/T-040/T-046 text sharpened; all rows remain `OPEN` | Traces for precision and disclosure findings |

No existing test ID was dropped; none was renamed.

## 3. Cross-document consistency checks performed

1. **Lock orders:** §C.2, §D item 2, §D.3a, §D.6 (AUTHZ) vs AC7.2 (ACCEPTANCE) vs `roleChangeRace`/`sessionRevokeRace`/`lastAdminRace` rows (TEST_PLAN) vs T-045/T-046/T-047/T-048 (THREATS) — all state the same two paths with sessions-before-users and ascending ids; `admin_control`-first restrict confirmed in all four.
2. **Sequencing:** REFUSAL §5 shared-counter model ↔ AC8.2/8.3 ↔ STMT-001/002 ↔ INV-001 ↔ `attempts`/`invariants`/`statements.api` rows ↔ T-033 — one terminology (`account_event_seq` concept; ledger column name `account_seq`; attempt column `event_seq`). The old `attempt_seq` name no longer appears as the ordering primitive anywhere.
3. **Status enum:** §F (AUTHZ) ↔ `ACCOUNT_NOT_ACTIVE` + `account_status_detail` + `NONZERO_BALANCE` (REFUSAL) ↔ AC2.4 (ACCEPTANCE) ↔ `accounts.test.ts` (TEST_PLAN) — same enum, same transitions, same zero-balance close rule.
4. **Destination disclosure:** REFUSAL §3 target-visibility rule ↔ §A transfer-destination row (AUTHZ) ↔ AC9.8/DEST-001/AUTH-007/TIMING-001 (ACCEPTANCE) ↔ `crossUser`/`destinationChecks` rows (TEST_PLAN) ↔ T-020/T-040 (THREATS) — single rule, no residual "409 SYSTEM" leak path for non-account-visible callers.
5. **Integer precision:** REFUSAL §2 ↔ AC3.5/AMT-001 ↔ `money`/`validation/amount`/`amounts.api` rows ↔ T-049 — same grammar, same range bound, same string-serialisation convention.
6. **Grep sweeps:** no surviving "identical latency" phrasing; no stray `403` on the forbidden path; no undefined codes remaining; threat table ends at T-049, all rows `OPEN`; every new code (`NONZERO_BALANCE`) has an owning row, section and test.
7. **Timing promise wording:** REFUSAL §0 + §3 + AUTH-007 + TIMING-001 all phrase latency as mitigation + statistical verification.

## 4. Exact changed sections (summary)

- `docs/REFUSAL_CODES.md` — header; §0; §1 (business row); §2 (integer-precision block + canonical order wording); §3 (target-visibility rule, row cells, admin-lifecycle table + `NONZERO_BALANCE`); §4 (`account_status_detail` field rule); §5 (**rewritten**); §6 (render note); §7 (Rev 3 map).
- `docs/AUTHZ_MATRIX.md` — header; §C.1.3 (operator identity); §C.2 (explicit session-first order); §D item 2; §D.6 (two paths); **§F new**; §E (Rev 3 map); Gate 2 checklist.
- `docs/ACCEPTANCE.md` — register (STMT-001/002, INV-001, AUTH-007, TIMING-001 ✱, AMT-001, DEST-001); AC1.5; AC2.4; AC3.5; AC7.2/7.3; AC8.2/8.3; AC9.6 (naming), AC9.8 (new); R7/R8/R9 tests rows.
- `docs/TEST_PLAN.md` — unit (`money`, `validation/amount`) rows; integration (`accounts`, `attempts`, `invariants`, `destinationChecks`) rows; api table (new `timing.api.test.ts`; rewritten `amounts.api`, `statements.api`, `crossUser`, `userLifecycle`; stale duplicate `statements` row removed).
- `THREATS.md` — T-033, T-020 (sharpened), T-049 (**added**, OPEN).
- `PROMPTS.md` — dated 2026-11-07 Rev 3 entry (honest listing of the nine defects caught by the reviewer).

## 5. Unresolved decisions (flagged for the human, not decided)

1. **Statistical tolerance value for TIMING-001** — the doc proposes "median difference < 5% over 200 calls, no monotonic signal" as a *proposal*; the exact bound is a Phase 12 measurement decision.
2. **`NONZERO_BALANCE` on close** — the zero-balance close precondition is my recommended default; the alternative (auto-drain to a controlled system account) would need an explicit admin cash-desk flow and is deliberately deferred. Confirm or edit.
3. **Two-part statement render** (vs a single merged list) — chosen for honesty about unsequenced rows; if the reviewer prefers a merged list, the interleaving rule must be specified and T-033/STMT-002 re-derived.
4. **`account_status_detail` availability on invisible-destination rows** — currently recorded when the destination was locked (source-like information); the alternative (never storing status detail for invisible targets) is stricter but loses audit clarity. Human preference requested.
5. **H-1/Gate 0** remain open as before (human tasks).

## 6. Integrity confirmation

Minimised scope: **documentation changes only** — no application code, no dependency installs, no migrations, no repository/Git-state modifications, no commits, no Phase 3 work. All 8 listed output documents exist and were updated in this session; the summary above lists every touched file. Nothing was marked Mitigated in `THREATS.md` (all rows remain `OPEN`); nothing was auto-approved; **Gate 2 remains unapproved pending your review of the Rev 3 documents.**
