# Discovery Brief — Phase 1 (greenfield, read-only for code)

- **Date:** 2026-11-06
- **Status:** Ready for review → accepted by human on 2026-11-06 (H-2, H-3, invariants answered; see §5)
- **Inputs:** `docs/PROJECT_BRIEF.md`, `docs/PROPOSED_DEFAULTS.md`, `docs/PACK_REVIEW.md`, `docs/QUALITY_GATES.md`, `THREATS.md`

## 1. Repository audit facts (P1.1)

The workspace contains **only the engineering kit**. Verified by listing every file:

| Fact | Evidence |
|---|---|
| No existing application code, no `package.json`, no dependency manifests anywhere | directory listing of `Snovasis/` → single child `ledgerline-repo-kit/`, which contains only `.md` files, `.claude/` (skills/agents/commands), `agents/`, `docs/`, `phases/`, `scripts/` (kit verifier), `templates/` |
| Not a git repository yet (`git status` → `fatal: not a git repository`) | `git -C ledgerline-repo-kit status` |
| Local tooling available | Node v22.15.1, npm 11.6.2, Git 2.50.1 (Windows), PostgreSQL 17.10 (`psql` on PATH). Docker not yet checked — part of Phase 0/4. |
| **Phase 0 (human-only) not started** | No portal sign-in evidence, no private GitHub repo, H-1 not yet asked. Gate 0 items remain the human's to complete. |

**Recorded conclusion:** there is nothing to audit on the code side; the frontend audit is deferred to the Phase 11 gate (as already decided in `docs/PACK_REVIEW.md`, gap G2). This is a fact, not an assumption.

## 2. The ten requirements in our own words (P1.2)

1. **Identity & roles.** Three server-recognised roles — administrator, account holder, read-only auditor — with credentials and sessions that cannot be spoofed by the client.
2. **Accounts and balances.** Accounts can be created; balances and per-account statements are visible to exactly the people permitted to see them.
3. **Money operations.** Deposits, withdrawals and internal transfers are first-class operations, each with defined validation and refusal behaviour.
4. **Conservation.** Internal transfers move money: what leaves A arrives at B in the same committed database transaction. External deposits/withdrawals are the only way customer totals change, and they must balance against an external clearing account.
5. **No overdraft.** No execution path — sequential, concurrent, retried, replayed — may drive a balance below zero. (Confirmed below.)
6. **Idempotency.** A retry with the same client key receives the first outcome replayed, never a second execution.
7. **Concurrency safety.** Simultaneous operations on the same accounts serialise safely through locks, not luck; no corruption, no lost or duplicated postings.
8. **Honest statements.** A statement shows every posting *and every refused attempt*, with running balance, initiator and outcome, in a deterministic order.
9. **Server-side authorisation.** Every endpoint re-derives the actor's permission for that account; the UI hiding a control is never the security control.
10. **Provable tests.** Conservation, concurrent no-overdraft, idempotent replay and cross-user authorisation are all exercised by automated tests against real PostgreSQL.

### Three marking-critical standards (restated from the pack)

> ⚠️ These are derived from the kit and event instructions. Phase 0 (P0.3) requires re-checking against the official portal wording; this line is an explicit open sub-task.

1. **Money behaves correctly.** Conserved, never overdrawn, never executed twice; database constraints and transactions do the enforcing, not the frontend.
2. **Evidence is real.** Tests actually ran; the demo is actually deployed; `PROMPTS.md`, `THREATS.md` and git history are truthful; nothing is claimed that was not verified.
3. **The candidate can defend it live.** Every line explainable, code changeable under interview pressure, and no autonomous AI money movement.

## 3. Ambiguities and conflicts found (P1.3)

| # | Ambiguity / conflict | Resolution |
|---|---|---|
| A1 | **Public-repo timing conflict** — email says stay private before deadline; deliverables mention a public repo | **Open (H-1, human).** Repo stays private until the placement cell answers. Ask on the portal. |
| A2 | **Who may deposit** — unrestricted holder deposit would let any demo user mint money | **Resolved (H-2, answered 2026-11-06):** DEPOSIT is admin-only; holders never deposit. Enforced server-side, tested as AUTH-003. |
| A3 | **Overdraft policy** — the brief permits a documented overdraft but warns against it | **Resolved:** **no overdraft in v1** (confirmed by human 2026-11-06). Enforced in application logic under a row lock **and** by a `balance >= 0` CHECK on customer rows as the database backstop. |
| A4 | **Refusal recording semantics** — a refusal rolled back with its transaction vanishes | **Resolved by design (D-9):** business refusals are *committed outcomes* inside the money transaction; authorisation refusals are written in a separate short audit transaction. Verified: THREATS T-021 / AUD-002, `docs/REFUSAL_CODES.md`. |
| A5 | **Idempotency key retention** — expiring keys can duplicate money during a late retry | **Resolved (D-8):** no expiry in v1; retention documented in `docs/IDEMPOTENCY_BEHAVIORS.md`. |
| A6 | **Not already in the register:** transfer whose *destination* is a SYSTEM (clearing) account | **New threat T-043** — destination must be an active CUSTOMER account, checked in-transaction (test DEST-001). |
| A7 | **Not already in the register:** seed/demo-restore script run twice double-posts demo money | **New threat T-044** — seed must be idempotent (SEED-001). |
| A8 | **Resolved (Gate 2 review, 2026-11-06):** statement visibility of *FORBIDDEN* refusals — **policy preserved**: holders with `VIEW` see refusals targeting their own account (initiator, reason — no payloads, no unmeasured balances), never attempts on other accounts; ADMIN/AUDITOR inspect the authorised audit records where the internal `FORBIDDEN` vs `ACCOUNT_NOT_FOUND` truth is kept. See `REFUSAL_CODES.md` §6. |
| A9 | **Explicitly deferred — cannot be resolved without the official portal wording (no guessing):** whether the pack's five-entries reading of `PROMPTS.md` matches the portal's expectation. The kit keeps the **stricter reading** either way; the actual official portal instructions must be checked by the human at Phase 0 P0.8, and this item is resolved or re-deferred **only** against that text — not against an assumption. |

## 4. Invariants confirmed (P1.4)

- **No overdraft in v1** — by explicit human confirmation, 2026-11-06. `I3` in the brief; enforced by the account row lock with the balance read **after** the lock and backstopped by `CHECK (balance >= 0)` on CUSTOMER rows.
- **Single currency INR**, integer minor units (**paise**), `BIGINT` storage, `BigInt` arithmetic; amounts validated as **raw JSON integer tokens** at the HTTP boundary (direct `BigInt` conversion, never via `Number` — `REFUSAL_CODES.md` §2), required to be `> 0` and within the per-operation cap. No binary floating point anywhere in the money path.

## 5. Decision list H-1..H-5 (P1.5)

| ID | Decision | Status | Recommendation |
|---|---|---|---|
| **H-1** | When may the repo become public? | **OPEN — human asks placement cell** | Ask today; keep the written reply. Default to private until deadline. |
| **H-2** | Who may deposit? | **ANSWERED 2026-11-06: admin-only deposits** | Was: admin-only. ✔ |
| **H-3** | Stack | **ANSWERED 2026-11-06: approved** — Node.js + TypeScript + Fastify + zod API; Next.js (App Router) frontend; PostgreSQL with raw SQL via `pg` (no ORM); `node-pg-migrate`; Vitest (+ Playwright smoke); docker-compose for local Postgres; GitHub Actions with a Postgres service container. | Was: TS/Fastify/Next. ✔ |

> **Amendment (BalanceVault expansion, human instruction 2026-11-09 — the 2026-11-06 answer above is kept verbatim as the historical decision):** the organizer clarified BalanceVault as the renamed, expanded LedgerLine challenge and mandated Prisma Client (routine typed access) and Redis (rate limiting only) in addition to this stack. The `pg` money path, `node-pg-migrate` authority and all financial decisions are unchanged; the boundary rules are normative in `docs/adr/ADR-005` §"Data-access transaction strategy". The "(no ORM)" clause of the 2026-11-06 answer is superseded **for routine non-financial access only**.
| **H-4** | Hosting provider (must allow a **second, non-owner** DB role) | **OPEN — explicitly deferred to Phase 4 (approved)** | Verify host capability **before** Phase 4 code, not at deploy time. Local PostgreSQL 17.10 already available as fallback for development. |
| **H-5** | Optional features (admin ADJUSTMENT, hash chain, AI flags, extra rate limiting) | **OPEN — explicitly deferred until after Gate 9 (approved)** | None by default. ADJUSTMENT is *deferred*, not dropped: its authorisation rows exist in `docs/AUTHZ_MATRIX.md` but no code is scheduled before Gate 9. |
| — | No overdraft + INR-only | **ANSWERED 2026-11-06: confirmed** | ✔ |
| — | Authorisation matrix (D-3 → `docs/AUTHZ_MATRIX.md`) | **PENDING HUMAN REVIEW** (asked for the document before signing) | Approve at Gate 2. |

### 5a. Gate 2 approved-decision record (2026-11-07 — from the human's decision list; not reopened)

| Approved decision | Recorded in |
|---|---|
| External deposits ADMIN only (H-2 restated) | `AUTHZ_MATRIX.md` §A/§B; `API_CONTRACT.md`; AUTH-003 |
| No overdraft: row lock, balance after lock, DB CHECK | A3 above; `PROPOSED_DEFAULTS.md` D-5/D-6/D-7; AC5.x |
| Last-admin protection via `admin_control` singleton | `AUTHZ_MATRIX.md` §C.2; ADMIN-001/002; T-045/T-047 |
| Sequence naming: counter `accounts.event_last_seq`, per-entry `account_event_seq` | `REFUSAL_CODES.md` §5; `DATA_MODEL.md`; `PROPOSED_DEFAULTS.md` D-5/D-6; test plans (old `last_seq`/`account_seq` names superseded) |
| `account_status_detail`: ADMIN/AUDITOR audit views only, never to holders | `REFUSAL_CODES.md` §4; AC9.9; new test ASD-001 |
| TIMING-001: best-effort, non-blocking, not a required CI gate | `ACCEPTANCE.md`/`TEST_PLAN.md`/`THREATS.md` T-020; `API_CONTRACT.md` |
| Account closure only at zero balance, checked under the account lock | `AUTHZ_MATRIX.md` §F; `NONZERO_BALANCE` |
| Statements: one merged timeline backed by `events`/`attempts` categories | `REFUSAL_CODES.md` §5 merge rule; AC8.2; STMT-002; T-033 |
| Bootstrap identity limitation accepted as documented residual risk | `THREATS.md` T-050 (ACCEPTED); `AUTHZ_MATRIX.md` §C.1.3 |
| Account lifecycle `ACTIVE`/`SUSPENDED`/`CLOSED`; SUSPENDED blocks credits and debits; ADMIN/AUDITOR may still view | `AUTHZ_MATRIX.md` §B/§F; AC2.4; test SUS-001 |
| Bootstrap creation disabled once an administrator exists; separate clearly-distinguished, audited override/rotation procedure | `AUTHZ_MATRIX.md` §C.1.3; AC1.5; ADMIN-001; TEST_PLAN `userLifecycle` |

### 5b. Gate 3 partial-decision record (2026-11-08 — human's formal acceptance of the four final-review technical decisions; Gate 3 **not** closed)

The human formally accepts the four technical decisions recommended at the Gate 3 final review (`docs/reports/PHASE-03-FINAL-GATE-3-REVIEW.md` §5). Per the human's explicit instruction, **all seven ADRs remain `Status: Proposed`**, Gate 3 is not closed, migration work stays blocked until the individual ADR acceptance is complete, and Phase 4 has **not** been started (not P4.1–P4.9; no commits; no scaffold).

| Accepted decision | Recorded in |
|---|---|
| Replay guarantee = **semantic replay** of the stored financial outcome (not byte-identical JSONB; `BYTEA` considered-not-chosen) | ADR-004 §1a; `DATA_MODEL.md`; `IDEMPOTENCY_BEHAVIORS.md` row 4; `REFUSAL_CODES.md` §3; `API_CONTRACT.md`; AC6.2/IDEM-001 |
| `admin_control` runtime grant = **`GRANT SELECT, UPDATE (updated_at) ON admin_control TO ledgerline_app`** (FOR SHARE and SECURITY DEFINER considered-not-chosen) | ADR-005 item 2; `AUTHZ_MATRIX.md` §C.2; `schema-draft.sql` grants block; TEST_PLAN mutation (g) |
| Journal balance = **two DEFERRABLE INITIALLY DEFERRED constraint triggers sharing `assert_journal_balanced()`**, catching zero-entry journals at COMMIT (balanced-append residual disclosed) | ADR-002 item 2 + risks; `schema-draft.sql`; JBL-001 ✱; `PHASE-06` P6.3; T-013 control cell |
| The PostgreSQL locking-clause privilege rule documented as a **necessity** for the lifecycle tables' `FOR SHARE` reads | ADR-005 item 2; `AUTHZ_MATRIX.md` §D.6/changelog; `schema-draft.sql` grants comment |

**Still required before Phase 4 (human's list, recorded verbatim in intent):** (1) individual review/acceptance of ADR-001…ADR-007; (2) H-1 — placement-cell decision on repository visibility (repo stays private); (3) verification that the private GitHub repository setup is correct; (4) Docker Desktop operational (engine currently **not running** — verified 2026-11-08; Docker CLI 29.1.3 present) — the human chose **docker-compose** as the Phase 4 local dev-database pattern; (5) H-4 hosting-provider decision and second-DB-role verification remain open and required **before** P4.8 deployment (hosting decision deferred).

## 6. What Phase 2 produces from this

Everything above becomes testable artefacts: `ACCEPTANCE.md` (requirement → criteria → test IDs), `AUTHZ_MATRIX.md`, `REFUSAL_CODES.md`, `IDEMPOTENCY_BEHAVIORS.md`, `TEST_PLAN.md`, `NON_GOALS.md`, and the threat register updates (T-043, T-044). No code is written in Phase 1 or 2.
