# Requirement Traceability Matrix — Phase 3

*Date: 2026-11-14 · Baseline: `main` @ `66f2b29`*

## Source-of-truth statement (limitation disclosed first)

The **original Snovasys challenge specification is not present in this
repository.** The in-repo source of truth is
[`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) — the human-approved record of the
in-scope requirements, role baseline and core invariants (I1–I8), dated and
maintained through the kit's gate process (`DISCOVERY.md`, `ACCEPTANCE.md`).
This matrix therefore maps requirements **to `PROJECT_BRIEF.md`, not to a
reconstructed or assumed original portal text.** Verifying the actual
submission portal/process remains a **human action** (H-1/Gate 0) and is not
claimed anywhere in this phase.

Statuses used: `VERIFIED` · `IMPLEMENTED — NOT VERIFIED` · `PARTIALLY
VERIFIED` · `BLOCKED — HUMAN ACTION REQUIRED` · `NOT IMPLEMENTED`.

Evidence-level tags: **[P]** verified in production · **[L]** verified locally
(live probes/manual) · **[T]** verified through automated tests (real
PostgreSQL + Redis, no mocks) · **[CI]** green CI run as evidence.

## Requirements (PROJECT_BRIEF §"In-scope requirements")

| # | Requirement | Implementation | Evidence | Status |
|---|---|---|---|---|
| R1 | Authentication with ≥3 roles: ADMIN, ACCOUNT_HOLDER, AUDITOR | `apps/api/src/http/routes/auth.ts`, `register.ts` (role floor `ACCOUNT_HOLDER`), `admin.ts` (role mgmt, last-admin guard), `auth/session.ts` | Registration→login→logout→revocation journey **[P]** (Phase 2, production); `auth.api.test.ts`, `register.api.test.ts`, `rolesBootstrap.test.ts` **[T]**; production `/me` + uniform-401 probes re-run this phase **[P]** | VERIFIED |
| R2 | Create accounts; view balances and statements | `accounts.ts` (admin-only create, audit-in-tx), `statements.ts` (merged timeline, keyset pagination) | Account/statement pages **[P]** (Phase 2); `accounts.test.ts`, `statements.api.test.ts` **[T]** | VERIFIED |
| R3 | Deposits (ADMIN-only, H-2), withdrawals, transfers | `money.ts` routes; `transactionRunner.ts` DEPOSIT branch = ADMIN role only; holders hold no `DEPOSIT` grant in v1 | Withdrawal/transfer journeys **[L]** (local DB, Phase 2); adversarial A5 (holder deposit refused) **[T]**; **production deposit: BLOCKED — HUMAN ACTION REQUIRED** (no ADMIN exists; slot reserved for the owner's real admin). Read-side of the money surface verified in production **[P]** | PARTIALLY VERIFIED — production deposit BLOCKED — HUMAN ACTION REQUIRED |
| R4 | Conservation invariant (transfers net to zero; customer totals change only via external movement) | Deferred `assert_journal_balanced` triggers; `invariants.ts` `assertGlobalInvariants`; `reconciliation.ts` conservation summary | Live probe: **customer_total 18,671,344 + clearing −18,671,344 = 0** over 7,348 journals **[L]**; `JBL-001`, `reconciliationConservation.api.test.ts` **[T]**; mutation M1/M2/M3 **[T]** | VERIFIED |
| R5 | No overdraft (deliberate documented policy: none) | `FOR UPDATE` ascending-id locks, balance check under lock, `CHECK (balance_minor >= 0)` backstop | `CON-001` exactly-one-succeeds **[T]**; M3 mutation (lock removed → both succeed → test fails) **[T]**; `INSUFFICIENT_FUNDS` path in `money.api.test.ts` **[T]** | VERIFIED |
| R6 | Idempotency: same key + same request → first result, no repeat | `(actor_id, operation, idempotency_key)` UNIQUE + unique-INSERT claim + stored `response_body` replay; replay re-evaluation gate (IDEM-006) | `IDEM-003/005` **[T]**; Phase 2 live replay + `KEY_REUSED` **[L]**; **seed re-run this phase: `replayed:true`, balances unchanged** **[L]** | VERIFIED |
| R7 | Concurrency safety (no overspend/corruption) | One raw-`pg` tx per command; session→users→grants→idempotency→accounts ascending-id lock order; deadlock/serialization retry ×3; 55P03/57014→503 key-not-consumed | `CON-001..004` **[T]**; `moneyTimeoutClassification.api.test.ts` **[T]**; `independentConnection` race harness **[T]** | VERIFIED |
| R8 | Statement includes every debit, credit, refused attempt, running balance, initiator | `statements.ts` merged two-part timeline (`account_event_seq` counter + `(occurred_at, global_seq)` attempts; FAILED rows excluded) | `statements.api.test.ts` `STMT-001/002` incl. skewed-clock fixtures **[T]**; statement page **[P]** (Phase 2) | VERIFIED |
| R9 | Server-side per-account authorization per action | Grant/role checks in-transaction (`FOR SHARE` re-reads); uniform-404 two-sided truth; self-grant refused; audit-view gating | `crossUser.api.test.ts`, `grantsAuth.test.ts`, `A1–A8` **[T]**; production role journeys (holder grant-visibility) **[P]** (Phase 2) | VERIFIED |
| R10 | Automated tests prove conservation, concurrent no-overdraft, idempotent replay, cross-user authorization | `apps/api/test/**` (26 files/202 tests, real services) + `apps/web` (5 files/48) | **Phase 3 re-run: 202/202 + 48/48 pass** **[T]**; CI run `43429125834` green at baseline **[CI]**; mutation-proven guards (M1/M2/M3) **[T]** | VERIFIED |

## Core invariants (PROJECT_BRIEF I1–I8)

| Invariant | Evidence | Status |
|---|---|---|
| I1 Balanced postings | `JBL-001` **[T]**; live probe 7,348/7,348 balanced **[L]**; DB trigger pair at COMMIT **[T]** | VERIFIED |
| I2 Customer balance conservation | `reconciliationConservation.api.test.ts` **[T]**; live conservation probe exact-zero **[L]** | VERIFIED |
| I3 No overdraft | `CON-001` **[T]** + M3 mutation proof **[T]**; `CHECK` backstop **[T]** | VERIFIED |
| I4 Exactly-once per key | `IDEM-003/005` **[T]**; live seed replay **[L]**; M2 mutation proof **[T]** | VERIFIED |
| I5 Payload binding (`KEY_REUSED`) | `IDEM-002/004` **[T]**; Phase 2 live check **[L]** | VERIFIED |
| I6 Authorization per account/action | `crossUser`, `grantsAuth`, A1–A8 **[T]**; production journeys **[P]** | VERIFIED |
| I7 Append-only history | `LED-001/001b/002` **[T]**; triggers fire for owner too **[T]**; residual: explicit owner-role `DISABLE TRIGGER` (disclosed, ADR-005) | VERIFIED (with disclosed residual) |
| I8 Auditability (statement fields per access level) | `STMT-001/002`, `AUD-001` **[T]**; `account_status_detail` never to holders **[T]**; production statement views **[P]** | VERIFIED |

## Success criteria (PROJECT_BRIEF §"Success criteria")

| Criterion | Evidence | Status |
|---|---|---|
| Clean clone: configure, migrate, seed, run from documented instructions | `README.md` setup; migrations verified idempotent this phase (6/6 applied, re-run = "No migrations to run!") **[L]**; demo runbook `DEMO_RUNBOOK.md` **[L]** | VERIFIED |
| Deployed demo supports all three roles | Production is deployed and healthy, but has **no ADMIN** (bootstrap slot reserved) → ADMIN role not demoable in production; ADMIN/holder/auditor journeys verified **[L]** locally and holder/auditor **[P]** in Phase 2 | PARTIALLY VERIFIED — production ADMIN demo BLOCKED — HUMAN ACTION REQUIRED |
| Automated tests exercise real PostgreSQL transaction/concurrency behaviour | Harness: real services, no mocks; 202 API tests **[T]**; CI **[CI]** | VERIFIED |
| Truthful threat register | `THREATS.md` rev 3: statuses with named tests; OPEN/ACCEPTED rows with reasons | VERIFIED |
| Dated AI-use record | `ledgerline-repo-kit/PROMPTS.md` (dated entries; **gap noted: the 2026-11-13 Phase 1/2 sessions did not add entries** — a Phase 3 entry is added covering this phase's AI use) | PARTIALLY VERIFIED |
| API documentation | `API.md`, `API_CONTRACT.md` (Rev 4 taxonomy) | VERIFIED |
| Demo instructions | `DEMO_RUNBOOK.md` (new this phase, 13 steps, verified seed determinism) | VERIFIED |
| Honest limitations | `WRITEUP.md` §unfinished; README "Known limitations"; `PHASE_3_FINAL_REPORT.md` §Remaining issues | VERIFIED |

## Non-reconstructed-spec statement

No requirement in this matrix was invented: each row cites
`PROJECT_BRIEF.md` (human-approved) and the audit/acceptance documents it
cross-references (`AUTHZ_MATRIX.md`, `REFUSAL_CODES.md`, `IDEMPOTENCY_BEHAVIORS.md`,
`ACCEPTANCE.md`, `TEST_PLAN.md`). If the original portal wording differs from
`PROJECT_BRIEF.md`, the human owner must reconcile before submission — see
`SUBMISSION_CHECKLIST.md` item 1.

## Deliberately not implemented (out of scope, per PROJECT_BRIEF)

Multiple currencies, interest/fees/overdraft policy, scheduled/batch payments,
holds/refunds, ADJUSTMENT posting (deferred under H-5), AI-driven money
movement, microservices/queues. Status: **NOT IMPLEMENTED — out of scope by
approved decision**, not defects.
