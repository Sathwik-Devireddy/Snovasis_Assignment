# Phase Report — Phase 3: Architecture and ADRs

- **Date:** 2026-11-07
- **Agent:** 03 system architect + 04 database/ledger roles (run by OpenCode/GLM at the human's instruction)
- **Status:** Ready for Gate 3 review — ADR set proposed, human acceptance required
- **Scope:** P3.1–P3.6b (ADRs), P3.7 (schema draft), P3.8 (operation sequences), P3.9 (failure-mode table). Documentation/read-only-for-code.

## Objective

Convert the Kit's decisions (`docs/PROPOSED_DEFAULTS.md` D-1…D-13 plus the approved Gate 2 decision set) into a complete, explainable ADR set so implementation has no open money semantics, plus the schema draft and operational walkthroughs the phase spec requires.

## Phase 3 task outcomes

| Task | Outcome |
|---|---|
| P3.1 ADR-001 stack and layering (H-3) | Held: human already approved the stack (recorded verbatim `DISCOVERY.md` §5, 2026-11-06); ADR-001 records this and the D-2 layering/dependency rule. **Status remains Proposed** — Gate 3 covers the layering half. |
| P3.2 ADR-002 ledger model (D-4/D-5/D-6) | Credit-normal double-entry; per-journal balanced (I1, deferrable constraint trigger); clearing = `SYSTEM` kind, never locked/cached; cached customer balance as read model + reconciliation; counter naming (`accounts.event_last_seq` / `account_event_seq`); closes the three DATA_MODEL "ADR-pending" questions. |
| P3.3 ADR-003 concurrency (D-7) | `READ COMMITTED` + declared lock chain; `FOR SHARE`/`FOR UPDATE` two-legal-orders rule; deadlock/serialization retry on the same key; lock/statement timeouts; SYSTEM rows never locked or updated. |
| P3.4 ADR-004 idempotency (D-8/D-9) | Text sequence diagram incl. the Rev 4b replay re-evaluation gate; `409 KEY_REUSED`-only conflict law; single atomic no-PROCESSING model; two-path refusal recording; no-expiry retention; **includes the P3.9 failure-mode table (process death at each step)**. |
| P3.5 ADR-005 append-only (D-10) | Layered roles/grants/triggers + named hash-chain extension deferred under H-5; **stated the accepted residual risk** (superuser/owner trigger disable — operator power, disclosed not hidden). |
| P3.6 ADR-006 authentication (D-11) | argon2id; opaque token hashed in `sessions`; cookie policy; single-origin rewrites; in-transaction session re-read as the first money-path lock; approved 2026-11-07 bootstrap posture (disable-after-first-admin, T-050 ACCEPTED residual). |
| P3.6b ADR-007 revocation vs in-flight (D-13) | Linearisation rule with exactly-two-legal-orders outcomes; no new lock classes; replay-gate interplay explicit. |
| P3.7 schema draft | `docs/schema-draft.sql` — draft for review, **not** a migration; every CHECK/UNIQUE/FK/trigger/sequence named; checksum list at the bottom. |
| P3.8 sequences | Deposit / withdrawal / transfer walkthroughs added to `docs/ARCHITECTURE.md` (allowed per the phase file), naming authN/authZ/key-claim/lock/balance-check/write/commit points. |
| P3.9 failure-mode table | Delivered inside ADR-004 (the transaction-atomicity ADR) — each death point mapped to stored effect, idempotency outcome and caller position. |

## Files created / changed

| File | Reason |
|---|---|
| `docs/adr/ADR-001-stack-and-layering.md` | P3.1 (new) |
| `docs/adr/ADR-002-ledger-model.md` | P3.2 |
| `docs/adr/ADR-003-concurrency-and-isolation.md` | P3.3 |
| `docs/adr/ADR-004-idempotency-and-refusals.md` | P3.4 + P3.9 |
| `docs/adr/ADR-005-append-only-and-db-roles.md` | P3.5 |
| `docs/adr/ADR-006-authentication-and-sessions.md` | P3.6 |
| `docs/adr/ADR-007-revocation-vs-inflight.md` | P3.6b |
| `docs/schema-draft.sql` | P3.7 |
| `docs/ARCHITECTURE.md` | Status note (ADR map) + new "Money-operation sequences (P3.8)" section |
| `PROMPTS.md` | Dated entry added at the close of the phase |
| `docs/reports/PHASE-03-report.md` | This file |

## Verification

- `scripts/verify-kit.sh` re-run after all files in place → **`kit OK`**.
- **Real-PostgreSQL parse check of the schema draft** (Phase 3 evidence; the draft is *not* a migration until Gate 3):
  - Procedure: disposable PostgreSQL 17.10 cluster `initdb`'d in the assistant temp dir (trust auth, port **5433**, never touching the human's service at 5432), scratch database dropped+recreated per run, every named statement executed with `ON_ERROR_STOP`.
  - Result: **32/33 statements parsed and applied cleanly**; the single expected gap is `CREATE CONSTRAINT TRIGGER ledger_entries_journals_balanced ... EXECUTE FUNCTION assert_journal_balanced()` — the deferred I1-check body, listed in the draft's own checklist as part of the migration set.
  - The first run created the full object set (proof the statements are not merely parseable); subsequent runs reproduce against a fresh scratch DB. Harness artifacts only, reported honestly: an early false-start attempt was abandoned when its assumed `fake-pg` package turned out unlicensed (npm 404 "Unpublished on 2025-06-23"); no such package was used in any final evidence. Scratch cluster and helper scripts were deleted afterward; nothing was committed to any database outside the disposable instance; the human's PostgreSQL service was read about (service state, `pg_hba.conf`) but never connected to or modified.
- No application tests exist yet (nothing to run — no code): none claimed.
- No DB state on the human's machine was modified; no Git operations were performed.

## Acceptance criteria (Gate 3) — status

- [x] ADR-001…ADR-007 exist per the phase spec, each from `templates/ADR_TEMPLATE.md` with Options-considered, Decision, Consequences, Verification and Revisit conditions.
- [x] Schema draft (P3.7) present with named constraints/triggers, marked not-a-migration, with the actual checklist for Gate-4 decisions still open.
- [x] P3.8 sequences recorded; P3.9 failure-mode table included.
- [ ] **ADRs marked Accepted by the human** — the remaining gate criterion; nothing depends on code until then.
- [ ] The human can explain ADR-003 and ADR-004 aloud without notes (Gate 3 criterion — practice material lives in `docs/INTERVIEW_PREP.md`; rehearsal is the human's).

## Risks / incomplete work

- The draft's sequence/grant sketch (`ledgerline_owner`/`ledgerline_app`, `SECURITY DEFINER` question for balance writes) is deliberately left open in the draft checklist; wants host capabilities (H-4) and belongs to the Phase 4 migration.
- Docker engine is installed but not running on this machine; the clean-clone story still needs the human to start Docker before Phase 4 (verified only as `docker --version` output).
- Implementation halt point: per `phases/PHASE-03-architecture.md` Gate 3 and `AGENTS.md`, **no schema/API/security-boundary implementation begins before the ADRs are accepted**. Incremental test-writing then starts with Phase 4 (and Phase 5–9 per-plan) rather than being skipped.
- `assert_journal_balanced()` body, workflow of the two `SYSTEM` kinds after Gate 9 and the hash-chain option (H-5) remain known future items, recorded in the ADRs' revisit conditions.

## AI review record

- The ADR set was drafted from the kit's own documents (PROPOSED_DEFAULTS D-1…D-13, REFUSAL_CODES, IDEMPOTENCY_BEHAVIORS, AUTHZ_MATRIX, DATA_MODEL, DISCOVERY decision record); each ADR cross-references its normative source rather than duplicating it, to reduce drift risk.
- Self-caught defects during writing (fixed in-place, noted here for honesty): stray artifacts inside prose (`( Roc:`, `stored身体`, `ownting:` and a garbled ADR-007 bullet that had drifted into invalid phrasing, plus one `documented,gb` fragment), a syntactically invalid placeholder constraint object and a typo'd function name (`refuse_append_onlyviol`) in the schema draft, and the drafting of a verification harness against an assumed `fake-pg` package that turns out to be **unpublished from npm** (npm 404: "Unpublished on 2025-06-23") — abandoned before any final evidence; the `kit OK` run and no `fake-pg` dependency exists in the kit. All were corrected or removed before anything was declared verified.
- The human should still read the ADRs themselves (especially ADR-003/ADR-004, per Gate 3's live-explanation criterion) before marking any as Accepted.

## Suggested commit

`docs(adr): propose ledger model, concurrency, idempotency, roles and auth decisions (Phase 3)`

## Human decision required (Gate 3)

- Mark ADR-001…ADR-007 **Accepted** (or request revisions).
- Explicitly confirm the stack in the ADR record (H-3 was approved verbally/in-session on 2026-11-06; the ADR asks for it once more as part of the formal accept-mark).
- Answer whether to start Phase 4 after acceptance (implementation begins per plan; incremental, tests alongside).

## Addendum — 2026-11-08: Gate 3 targeted consistency review (documentation-only corrections)

The Gate 3 review returned six findings; all were corrections to this phase's deliverables, applied documentation-only (16 files; full file list and per-file detail in the dated `PROMPTS.md` entry):

1. **Replay accounting (ADR-004 §4 + REFUSAL_CODES §3 + IDEMPOTENCY_BEHAVIORS row 7 + DATA_MODEL + PHASE-09 + schema draft + skills):** v1 records **no replay-side writes** — the earlier §4/"duplicate visibility" text prescribed exactly the writes the Rev 4b evaluation-only gate forbids (`replay_count`, an `idempotency_replays` table, `IDEMPOTENT_REPLAY` audit rows). The `replayed: true` envelope field is now the only trace of a passing replay; per-replay accounting is deferred to a later version with explicit human opt-in. The `replay_count` column was removed from `docs/schema-draft.sql`.
2. **Owner-role verification (ADR-005):** the earlier Verification line ("the same statements as owner are the control path") was wrong; replaced by the trigger-accurate statement test — append-only triggers fire for **every** session including `ledgerline_owner`; the owner = migrations/DDL only, never ledger-data mutation; the sole bypass is an explicit `ALTER TABLE … DISABLE TRIGGER` (disclosed residual). `ACCEPTANCE.md` LED-001, `TEST_PLAN.md appendOnly.test.ts`, THREATS T-009/T-026 aligned.
3. **Idempotency claim wording (ADR-003 + ADR-004 + both chain texts in AUTHZ_MATRIX §D.6 / ACCEPTANCE AC7.2 + skill):** the claim is a **unique INSERT, not an explicit `SELECT FOR UPDATE` step**; a concurrent duplicate waits on the uncommitted unique entry, so no new lock class exists.
4. **Accounts-update boundary (ADR-005 item 2 + schema draft grants block):** decided at this pass — **direct column-level grants** for `ledgerline_app` on `accounts` (`balance_minor`, `event_last_seq`, `updated_at`, `status`); SECURITY DEFINER recorded as considered-not-chosen (extra in-lock PL/pgSQL hop; write hidden in a function body). This decision was made by the AI under instruction and may be overridden by the human at Gate 3 review. The schema draft's planned-grants block now matches it exactly (append-only set `SELECT, INSERT` only; `idempotency_records SELECT, INSERT, UPDATE` with no DELETE; lifecycle tables scoped; `GRANT SELECT ON accounts` included).
5. **ADR-006 bootstrap vs the approved record:** compared against `AUTHZ_MATRIX.md` §C.1.3 decision 12, `ACCEPTANCE.md` AC1.5 and T-050 (ACCEPTED) — **no genuine conflict found**; item 5 was enriched with the exact provenance clauses (env-sourced operator id, `operator_context`, typed phrase, CI refusal default, same-transaction session revocation) instead of reporting a conflict.
6. **Cross-document coherence:** replay wording made precise in ADR-007 item 5 (revocation-after → gate refuses; revocation-before → the original never committed an outcome); T-028 control updated ("no replay-side writes at all"); PHASE-09 P9.8 rewritten to the no-new-rows proof; Gate-9 acceptance now counts `idempotency_records` rows.

**Verification:** post-edit sweep confirms only reserved-v2 annotations remain for replay-accounting terms; every modified file re-read completely (two self-caught errors fixed during re-reads: the `idempotency_records` UPDATE omission, contradicting D-8 step 7, and a missing `GRANT SELECT ON accounts`); `scripts/verify-kit.sh` re-run — **`kit OK`**. No tests were run (none exist); no Git commands. All seven ADRs remain **Proposed**; Gate 3 acceptance and any Phase 4 start remain the human's decisions.
