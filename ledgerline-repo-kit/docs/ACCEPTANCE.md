# ACCEPTANCE.md — Testable acceptance criteria for the ten requirements

- **Phase:** 2 (P2.1) · **Date:** 2026-11-06 · **Status:** Ready for Gate 2 review
- Mapping rule: each requirement is **accepted** only when all its criteria pass and every listed test ID has actually been run against real PostgreSQL (or recorded as a verified live-check for UI roles).

## Test-ID register (canonical)

Test IDs come from `docs/QUALITY_GATES.md` and the threat register; new IDs introduced here are marked ✱. This register is the single source of truth; code and tests must mirror these names.

| Test ID | Layer | Scenario (short) |
|---|---|---|
| FIN-001 | integration | Transfer conserves customer funds (balanced postings, one transaction) |
| FIN-002 | integration | Fault injection between debit and credit → full rollback, no partial mutation |
| CON-001 | concurrency | Two withdrawals race on insufficient combined funds → at most one succeeds, never negative |
| CON-002 | concurrency | Opposite-direction transfers race → no corruption, safe deadlock handling |
| CON-003 | concurrency | Deadlock/serialization retry always reuses the **same** key inside the transaction |
| CON-004 | concurrency | Many concurrent deposits/withdrawals all finish; clearing never serialised; totals exact |
| IDEM-001 | integration | Same request/key twice → one journal, second response replays the first (semantic replay: same status + same business values + `replayed: true`; ADR-004 §1a) |
| IDEM-002 | integration | Same key, changed payload → conflict, no movement |
| IDEM-003 | concurrency | Same key concurrently → one execution, other replays stored result (serialised by the unique constraint; loser passes the row-7 gate then replays) |
| IDEM-004 | integration | Key reused across users/operations is a *different* key (scope check) |
| IDEM-005 | integration | Commit succeeded but response lost → retry with same key replays outcome |
| IDEM-006 | concurrency | **Replay re-evaluation gate** (`IDEMPOTENCY_BEHAVIORS.md` row 7; `REFUSAL_CODES.md` §3): before any stored outcome (success or refusal) returns — revoked/expired session → **401 `UNAUTHENTICATED`** (never a 404 for the revocation); revoked grant / lost visibility → the single uniform **404 `ACCOUNT_NOT_FOUND`** envelope; still-visible suspended/closed account → **409 `ACCOUNT_NOT_ACTIVE`**; stored response only when all three pass; the `FOR SHARE` status re-read serialises with concurrent suspension/closure — exactly two legal orders; the gate pass and all **post-claim** refusals (`KEY_REUSED`, gate-stage-(c) 409) are evaluation-only: **no new attempt rows, no counter bump**; a revoked-grant/visibility replay is refused earlier — at D-8 step 1b, **before the key row is read** — and records one D-9 authorisation-refusal attempt row per refused call — one insert attempted, exactly one durable row when persistence succeeds (key-state-independent, NULL balance/seq, T-042-bounded; a failed insert is logged and never suppresses the refusal; REPLAY-AUTHZ-001) |
| REPLAY-AUTHZ-001 | concurrency | **Replay refused by authorisation (D-8 step-1b site, pre-claim; approved DEC-2, 2026-11-09 — report `docs/reports/ADR-004-REPLAY-REFUSAL-CONSISTENCY-REVIEW.md`)**: after a committed same-key outcome, a retry with the grant revoked / visibility lost returns the uniform `404 ACCOUNT_NOT_FOUND` envelope; the stored body is withheld, the key row is untouched, and there is no journal/balance/`event_last_seq` change; **exactly one D-9 audited FORBIDDEN attempt row per refused retry when persistence succeeds** (best-effort: a failed insert is logged and the refusal still returns — never suppressed; `balance_at_attempt_minor` and `account_event_seq` NULL, verbatim `supplied_account_ref`, fresh `global_seq`; volume bounded by T-042); a different-payload retry by the same now-unauthorised caller returns the same 404 envelope — **never** `409 KEY_REUSED` (authorisation precedes the key row; precedence ladder); a replay after session revocation instead returns **401 with no attempt row** (the F-3 asymmetry is deliberate and asserted); real PostgreSQL required (grants `FOR SHARE` vs revocation `UPDATE` linearisation). *The revocation-write audit is the approved pre-claim policy — the gate itself never writes* |
| JBL-001 ✱ | integration | **Deferred journal-balance enforcement** (ADR-002; `docs/schema-draft.sql`, two deferred constraint triggers + `assert_journal_balanced()`): **zero-entry journal rejected at COMMIT** (the `journal_transactions` trigger fires even with no entries); one-entry journal rejected; unbalanced multi-entry journal rejected; balanced two-entry/multi-entry journals commit; currency-inconsistent journal rejected; every rejection aborts the whole transaction leaving zero journal/entry/attempt/balance rows; concurrent postings each satisfy the invariant; mutation check: disabling the triggers makes this fail |
| AUTH-001 | api | Non-holder attempts another account's operation → rejected, no mutation |
| AUTH-002 | api | Auditor attempts money movement → rejected |
| AUTH-003 | api | Account holder attempts deposit → rejected (admin-only policy, H-2) |
| AUTH-004 | api | Admin attempts self-grant → rejected; every grant audited |
| AUTH-005 | api | Brute force / user enumeration at login → rate limit, uniform errors |
| AUTH-006 | api | Session theft / CSRF → cookie flags, hashed tokens, Origin check, logout revokes |
| AUTH-007 | api | Inaccessible/non-existent destination → uniform error envelope, no existence **or classification** leak (incl. SYSTEM kind/status of invisible destinations, DEST-001); timing only *mitigated*, verified statistically by TIMING-001 — no absolute identical-latency claim |
| TIMING-001 ✱ | api | **Best-effort statistical timing check** (approved decision 7) of the uniform envelope across account-exists vs absent vs forbidden across a fixed sample size (e.g. 200 calls × 3 cases), asserting a documented tolerance (e.g. median difference < 5% and no consistent monotonic signal); realistic mitigation evidence, not a latency guarantee. **Non-blocking: it records evidence but is NOT a required CI pass criterion — a failing tolerance must not gate the build** |
| AUTH-008 | concurrency | Revocation races an in-flight transfer → one of the two legal orders, consistent ledger |
| ADMIN-001 ✱ | unit/api | Last-active-admin guard: demotion/disable refused (`LAST_ADMIN_PROTECTED`); bootstrap provisioning single-run and **disabled once an administrator exists** (approved decision 12); separate audited rotation procedure verified (env-sourced operator id, confirmation phrase, CI refusal default, `admin_credential_rotation` audit event, same-transaction session revocation) (T-045) |
| ADMIN-002 ✱ | concurrency | Two concurrent demotions of different admins race on `admin_control` (`FOR UPDATE`): at least one active administrator always remains (T-047) |
| ROLE-001 ✱ | concurrency | Role change / user disable races an in-flight money command → one of the two legal orders; sessions of the changed user revoked (T-046) |
| SESS-001 ✱ | concurrency | Logout / session revocation races an in-flight money command → session row `FOR SHARE` inside the transaction; exactly two legal orders; post-revocation calls 401 (T-048) |
| AUTH-009 ✱ | integration | Refusal against a **nonexistent** account persists an attempt row: verbatim supplied id, internal reason, NULL account FK/`account_event_seq`/balance, uniform 404 untouched (Gate 2 Rev 2 finding; REFUSAL_CODES §5) |
| LED-001 | integration | Runtime role UPDATE/DELETE on ledger rows rejected — and the **same statements run as `ledgerline_owner` are also rejected by the append-only trigger** (triggers fire for every session; owner = migrations/DDL, never ledger-data mutation; sole bypass is an explicit `ALTER TABLE … DISABLE TRIGGER`, the disclosed T-026 residual) |
| LED-002 | integration | Runtime lacks TRUNCATE; statement triggers raise; owner role needed for migrations |
| AUD-001 | integration/api | Refused attempt appears in permitted statement with accurate actor/time/reason/status |
| AUD-002 | integration | Business refusal stays committed even under rollback conditions |
| STMT-001 | integration | Statement merged-timeline ordering: **event** rows (postings + locked refusals) ordered by per-entry `account_event_seq` (allocated from `accounts.event_last_seq` under the account lock) — consistent under concurrent commits, gap-free, running balance from postings only; event rows follow the counter, **not the clock**: a **skewed/non-monotonic `occurred_at` fixture** (e.g. a transaction that started earlier but bumped later after a lock wait) still yields event order = `account_event_seq` order, with timestamps never used as the event ordering key (T-033) |
| STMT-002 | api | Statement includes every posting **and** refused attempt in **one merged `timeline`** (approved decision): rows categorized `event`/`attempt`; events ordered by `account_event_seq`, attempts (unsequenced) by `(occurred_at, global_seq)` flagged `event_position: null`; the merged array is produced by a **deterministic head-first interleave of the two pre-ordered lists** (earlier `occurred_at` first; exact-tie → event first), so no merge can reorder rows within a category and **event order never derives from wall-clock timestamps**; **no fabricated sequence positions ever claimed for attempt rows**; FAILED rows never present |
| ASD-001 ✱ | api | **Holders never receive `account_status_detail`** (approved decision 6): response-shape assertion over suspended/closed source and destination cases, nonexistent and SYSTEM targets, and statement rows — the field exists only on ADMIN/AUDITOR audit views; no external response, holder statement or holder-visible field carries it |
| SUS-001 ✱ | integration | **SUSPENDED blocks both credits and debits** (approved decision 11): deposit *to*, transfer-*credit to*, withdrawal *from* and transfer-*debit from* a suspended account are all refused (`ACCOUNT_NOT_ACTIVE` internally; envelope per target-visibility rule); ADMIN/AUDITOR views of a suspended account still work; resume restores movement |
| INV-001 | integration | `assertGlobalInvariants` after every integration/concurrency test — over the **shared** event counter `accounts.event_last_seq`: the union of allocated values in `ledger_entries.account_event_seq` and locked-`REFUSED` `transaction_attempts.account_event_seq` per account is gap-free, monotonic and equals 1..`event_last_seq`; `global_seq` is deliberately non-gap-free (only strictly-moving) and excluded; balances reconcile |
| AMT-001 ✱ | unit/api | Amount boundary validation on **raw JSON tokens**: integer grammar, per-op cap, ≤ 0, magnitude beyond signed 64-bit → `VALIDATION_FAILED`; valid token > cap or ≤ 0 → `INVALID_AMOUNT`; `BigInt` conversion never via `Number`; responses serialise money fields as strings (T-008, T-023, T-049) |
| RET-001 ✱ | unit | Key retention policy: replay after artificial delay still safe (no expiry in v1) |
| INF-001 ✱ | integration | DB failure mid-command → transaction aborted, retry safe after reconnect |
| LOG-001 ✱ | api | No password/token/secret in logs or responses (redaction review + scan) |
| LOAD-001 ✱ | live | Load smoke: pool limits, lock/statement timeouts, flood of forbidden calls |
| DEST-001 ✱ | integration | SYSTEM-kind destination refused **internally** with exact reason recorded; externally the target-visibility rule applies (uniform 404 envelope to non-account-visible callers; granular 409 only to account-visible callers) (T-043, T-020) |
| SEED-001 ✱ | integration | Seed script re-run does not double-post demo money (idempotent seed) |
| RATE-001 | api | **Redis-backed API rate limiter** (BalanceVault): per-actor (identity from the resolved session where present, else IP) limits on register/login and money endpoints; over-limit → **429** with zero side effect (no attempt rows, no money movement, no user-row change); limits configurable via env |
| RATE-002 | api | **Limiter degraded mode (T-060):** with Redis unavailable the API fails soft (limiting bypassed, health degraded) while the DB-side T-042 attempt-write cap still bounds audit rows; money-path correctness, idempotency and audit recording do not depend on Redis |
| REG-001 | integration | **Registration/onboarding authority boundary (BalanceVault):** `POST /register` creates only a role-`ACCOUNT_HOLDER` user with **no accounts, grants or money authority**; password stored argon2id; registered-but-ungranted user cannot reach any account operation (404/403 matrix per `AUTHZ_MATRIX.md`) |
| REG-002 | integration | Duplicate-email registration refused (no user-existence disclosure beyond the canonical error); rate limit applies (AUTH-005 pattern); no ADMIN or AUDITOR role can ever be self-assigned |
| BOOT-001 | integration | **Bootstrap script executable** (`AUTHZ_MATRIX.md` §C.1.3): creates the first ADMIN from host-env secret; argon2id storage; `bootstrap_created` audit event; password printed once by the host, never stored |
| BOOT-002 | integration | **Bootstrap refuses on re-run** once an ADMIN exists (approved decision 12); no override path through bootstrap; rotation unchanged (env-sourced operator + audit event) |
| PRODROLE-001 ✱ | live/deploy | **Production database-role verification (H-4 window, before P4.8):** the host permits the second non-owner role `ledgerline_app`; the role serves **both** raw-`pg` and Prisma connections with the ADR-005 boundary privileges (LED-001/002 statements pass identically through both clients); owner-role DDL denied |
| PRISMA-001 | integration/ci | **No schema drift:** introspected schema (via Prisma) === the node-pg-migrate migrated schema; CI fails on drift; `prisma migrate` commands are not wired anywhere |
| TX-BOUNDARY-001 | ci/review | **Money-path boundary guard:** lint/architecture check that money-path modules contain no Prisma import and no multi-pool transaction; every financial operation opens exactly one `pg` client transaction (ADR-005 strategy) |
| HEALTH-001 | api | `/health` liveness credential-free; `/ready` fails (not `ok`) when PostgreSQL or Redis is unreachable; readiness verified during the P4.8 deployment window |
| DEPLOY-001 ✱ | deploy | **Deployment readiness:** documented commands deploy API + DB + Redis; secrets from host env only; `/health` reachable from an external network; PRODROLE-001 recorded; no `.env`/secret ever committed |

## Requirement → criteria → tests

### R1 — Authentication with ≥3 roles
- AC1.1 Passwords stored with argon2id; sessions are opaque random tokens stored **hashed**; cookie is `HttpOnly; Secure; SameSite=Lax`.
- AC1.2 Roles ADMIN / ACCOUNT_HOLDER / AUDITOR are server-derived from DB data; a client cannot assert a role.
- AC1.3 Login uses rate limiting and returns an identical error for unknown user vs wrong password.
- AC1.4 Logout revokes the session row server-side (`UPDATE sessions SET revoked_at = now()`); the single active-session representation is the predicate **`revoked_at IS NULL AND expires_at > now()`** — there is no session `status` column (`docs/schema-draft.sql`; ADR-006); role change / user disable revokes **all** of that user's sessions in the same transaction (AUTHZ_MATRIX §D).
- AC1.5 The first ADMIN exists only via the out-of-band, single-run bootstrap path (host-generated password, audited); there is no self-registration route (AUTHZ_MATRIX §C.1, T-034). **Bootstrap creation is disabled once an administrator exists (approved decision 12)** — a re-run refuses with no override path through bootstrap. Any credential rotation/recovery is a **separate, clearly distinguished and audited host procedure** (`rotate-admin-credentials`; distinct `admin_credential_rotation` audit event) that requires an **env-sourced** operator id (`LEDGERLINE_OPERATOR_ID` from the trusted deployment context — a CLI-only value is refused and is never treated as identity proof; the residual limitation is accepted, THREATS T-050) + the exact typed confirmation phrase, is refused in non-interactive contexts by default, records the claimed operator + invocation context, and revokes the target's sessions in the same transaction.
  - **Amendment (BalanceVault expansion, human instruction 2026-11-09):** self-service **holder registration is now required** (R11/REG-001). The no-self-registration rule's security intent is preserved for what it protected: the **first-admin / credential-perimeter rule is unchanged** (no self-registration can create an ADMIN, provide an account, or grant permission), and registration is rate-limited. The original wording "no self-registration route" no longer applies to holder-only registration.
- AC1.6 A change that would leave zero active ADMIN users is refused server-side (`LAST_ADMIN_PROTECTED`); all count-reducing admin operations serialise on the `admin_control` singleton row (`FOR UPDATE`) so two concurrent demotions can never both proceed (AUTHZ_MATRIX §C.2, ADMIN-001/ADMIN-002).
- Tests: AUTH-001..006, ADMIN-001, LOG-001.

### R2 — Create accounts; view balances and statements
- AC2.1 ACCOUNT creation is admin-only and writes the account with currency, kind and zero balance via migration-safe defaults.
- AC2.2 Balance views are server-computed from the stored (lock-consistent) balance, never client math.
- AC2.3 List/read access is grant-filtered server-side (deny by default).
- AC2.4 Account status enum is exactly `ACTIVE` / `SUSPENDED` / `CLOSED` (`AUTHZ_MATRIX.md` §F; approved decision 11): transitions admin-only and audited (`ACTIVE→SUSPENDED→ACTIVE`, `→CLOSED` terminal — reopen impossible); **`SUSPENDED` blocks both credits and debits** — deposit-to, transfer-credit-to, withdrawal-from and transfer-debit-from are all refused, while ADMIN/AUDITOR (and granted holders, read-only) may still view (SUS-001); close requires **zero balance, checked under the account lock** (approved decision 8) → `NONZERO_BALANCE` otherwise; SYSTEM accounts are schema constants outside this lifecycle.
- Tests: AUTH-001, AUTH-007, STMT-001/002, DEST-001, SUS-001, accounts status tests.

### R3 — Deposits, withdrawals and transfers
- AC3.1 Deposit = debit `EXTERNAL_CLEARING`, credit customer, balanced journal, admin-only (H-2); destination must be an active CUSTOMER account.
- AC3.2 Withdrawal = debit customer, credit clearing, admin-or-granted-holder only; **source must be an active CUSTOMER account**; funds-checked inside the transaction.
- AC3.3 Transfer = debit source + credit destination in one transaction; source and destination must be active **CUSTOMER** accounts.
- AC3.4 All three run through the same money-command runner (pre-lock semantic validation → account-row locks → under-lock checks → journal → balance update; D-8 steps 3–7).
- AC3.5 `amount_minor` (and every money JSON field) is validated at the HTTP boundary against the **raw token** (integer grammar; no float/exponent edge), converted directly to `BigInt` — never via `Number` — so unsafe JSON integer tokens cannot silently round into valid amounts; tokens beyond the signed 64-bit range and non-integer shapes are `VALIDATION_FAILED`; ≤ 0 / over-cap are business `INVALID_AMOUNT` (NULL balance); responses serialise money as strings (T-049, AMT-001).
- Tests: FIN-001, FIN-002, CON-004, AUTH-003, DEST-001.

### R4 — Conservation invariant
- AC4.1 For every journal transaction: Σ debits = Σ credits (enforced by domain builder **and** the deferred constraint-trigger pair + `assert_journal_balanced()` — the `journal_transactions` trigger catches even zero-entry journals at COMMIT; JBL-001). Every POSTED journal holds ≥ 2 entries in one consistent currency.
- AC4.2 Internal transfer: sender decrease exactly equals receiver increase in the same committed transaction.
- AC4.3 Global invariant: Σ all customer balances + clearing balance = 0, verified by reconciliation.
- Tests: FIN-001, FIN-002, INV-001, JBL-001.

### R5 — No overdraft
- AC5.1 Under concurrent racing withdrawals on the same funds, no committed path produces a negative balance.
- AC5.2 `CHECK (kind='CUSTOMER' → balance >= 0)` is the database backstop; the app never relies on it alone.
- AC5.3 Mutation check (Phase 12): removing the row lock makes CON-001 fail; restoring it makes CON-001 pass.
- Tests: CON-001, CON-002, INV-001.

### R6 — Idempotency
- AC6.1 Keys are unique per `(actor_id, operation, idempotency_key)` in a DB unique constraint.
- AC6.2 Replay of the same canonical payload returns the stored outcome with no second financial effect — **only after the replay re-evaluation gate passes** (revoked/expired session → 401 `UNAUTHENTICATED`; revoked grant / lost visibility → uniform 404 envelope; still-visible non-`ACTIVE` account → 409 `ACCOUNT_NOT_ACTIVE`; IDEM-006, `IDEMPOTENCY_BEHAVIORS.md` row 7). The replay is **semantic** — stored status + stored business values + `replayed: true`; byte-level JSON equality is not promised (ADR-004 §1a).
- AC6.3 Same key, different canonical payload → rejected conflict (409), no movement.
- AC6.4 Concurrent same-key requests → exactly one execution wins; the loser then passes the same replay re-evaluation gate (row 7) and replays the stored result.
- AC6.5 Honest wording everywhere: "**at most one financial effect per scoped key**", with replay of the stored outcome.
- Tests: IDEM-001..006, RET-001.

### R7 — Concurrency safety
- AC7.1 All money commands lock the involved CUSTOMER account rows `FOR UPDATE` in ascending-id order; balance is read only after the lock.
- AC7.2 **Lock order (Rev 3)** — two documented, cycle-free paths (`AUTHZ_MATRIX.md` §D.6), never a single misleading chain:
  - *Money path:* `actor's session row (FOR SHARE) → actor's users row (FOR SHARE) → grant rows (FOR SHARE, ascending id) → idempotency key claim (a unique INSERT — not an explicit lock step; the uniqueness conflict makes a concurrent duplicate wait until the winner commits/rolls back — ADR-003) → customer account rows (FOR UPDATE, ascending id)`;
  - *Admin-lifecycle path:* `admin_control row (FOR UPDATE, only when count-reducing) → target's session rows (FOR UPDATE, ascending id) → target's users row (FOR UPDATE)`, and nothing beyond.
  Both agree on the shared `sessions → users` segment; the paths never contradict each other, so no cycle can form. Deadlock/serialization failures retry the whole command with the **same** key; lock and statement timeouts prevent indefinite stalls.
- AC7.3 Deadlock/serialization failures retry the whole command; lock and statement timeouts prevent indefinite stalls.
- Tests: CON-001..004, IDEM-003, AUTH-008, ROLE-001, SESS-001, ADMIN-002, LOAD-001.

### R8 — Statement completeness
- AC8.1 Every statement lists: posting type, direction/amount, resulting running balance, initiator (actor + role), timestamp, and status/refusal reason where applicable.
- AC8.2 **Merged statement timeline (approved decision 9; `REFUSAL_CODES.md` §5)**: one `timeline` array; every row categorized `event` (postings *and* business refusals recorded under the account lock, ordered by per-entry `account_event_seq`) or `attempt` (all refused attempts targeting the account without an event position — pre-lock business refusals; authorisation refusals — flagged `event_position: null`, ordered by `(occurred_at, global_seq)`). Array merge: a **deterministic head-first interleave of the two pre-ordered lists** (earlier `occurred_at` first; exact tie → event first); each category's internal order is preserved **under all clock conditions** — event order always follows `account_event_seq`, never the wall clock (timestamps are not assumed monotonic). Condition: pre-lock / authorisation-refusal / FAILED rows must **not** claim an event sequence position or a balance (`REFUSAL_CODES.md` §5); balances appear only where measured under the lock; the timeline never fabricates a sequence position for a row recorded outside the lock discipline.
- AC8.3 Order and running balances are consistent even when commits race — postings and locked refusals share one gap-free per-account counter (`accounts.event_last_seq`) allocated under the account lock; running balance is computed from postings only.
- AC8.4 A reconciliation check proves stored balance equals the ledger-derived balance.
- Tests: STMT-001/002, AUD-001/002, INV-001.

### R9 — Server-side per-account authorisation
- AC9.1 Every account-specific request re-checks the actor's account grant server-side; deny by default.
- AC9.2 The matrix in `docs/AUTHZ_MATRIX.md` is the reference; policy code and tests mirror it (mutation-checked in Phase 12).
- AC9.3 Admin cannot grant permissions to themselves; grants are audited; roles cannot escalate by request content.
- AC9.4 Authorisation refusals are **externally indistinguishable from non-existence**: identical HTTP status (404), identical body shape/message and code (single `ACCOUNT_NOT_FOUND` envelope), regardless of whether the account is absent or hidden — truth kept only in the internal attempt row (`REFUSAL_CODES.md` §0/§3).
- AC9.5 Role change / user disable / session revocation interacting with an in-flight money command resolves to exactly one of two legal orders (§D of `AUTHZ_MATRIX.md`), and all sessions of the changed user are revoked server-side; no third ambiguous ordering is possible, and the ledger stays consistent.
- AC9.6 A refused operation targeting a **nonexistent** account still produces a persisted audit row: the supplied identifier is recorded verbatim, the internal reason is exact, no account FK/`account_event_seq`/balance is claimed, and the caller still receives the uniform 404 envelope (AUTH-009, `REFUSAL_CODES.md` §5).
- AC9.7 A money command re-validates its actor's session row `FOR SHARE` inside the transaction; a concurrent logout/revocation serialises on that row (`AUTHZ_MATRIX.md` §D.3a) — post-revocation calls get 401, in-flight authorised commands complete, nothing in between.
- AC9.8 Classification disclosure is closed: an unauthorised caller probing a *destination* account gets the same uniform 404 envelope whether the account is absent, forbidden, closed, suspended or of kind SYSTEM — never the account's existence or kind/status; internal audit rows keep the exact reason; only account-visible callers (e.g. ADMIN cash-desk operations) can receive granular 409 target codes; latency equalisation is a mitigation verified statistically, not an absolute promise (TIMING-001 — best-effort and non-blocking, not a required CI gate) (AUTH-007, DEST-001, T-020).
- AC9.9 `account_status_detail` is **ADMIN/AUDITOR audit-view content only** (approved decision 6): no external response, holder statement or holder-visible API field ever carries it — including suspended/closed destinations and sources (ASD-001).
- Tests: AUTH-001..004, AUTH-006..009, TIMING-001, ASD-001, ADMIN-001, ADMIN-002, ROLE-001, SESS-001.

### R10 — Automated tests prove it
- AC10.1 Every listed test lives in `apps/api/test/**` per `docs/TEST_PLAN.md` and runs against real PostgreSQL (not mocks) through independent connections/transactions for concurrency tests.
- AC10.2 `assertGlobalInvariants(db)` runs after every integration and concurrency test.
- AC10.3 A public test report (output logs / CI run) is committed as evidence at each phase gate.
- Tests: all; meta-verifiers INV-001 and CI configuration.

### R11 — BalanceVault expansion (mandated by the organizer's clarification; original financial requirements unaffected)
- AC11.1 **Prisma Client** performs typed routine access (users, sessions, account/grant administration, audit-event recording, statement reads) while **every financial operation remains a single raw-`pg` transaction** — locks, balance checks, ledger posts, idempotency and audit writes in one transaction; no financial statement ever runs through Prisma; no operation is split across pools (`ADR-005` §"Data-access transaction strategy"; TX-BOUNDARY-001).
- AC11.2 **Migration authority:** node-pg-migrate only; Prisma mirrors the migrated schema (PRISMA-001); `prisma migrate` is not wired.
- AC11.3 **Redis rate limiting** on register/login/money endpoints; over-limit → 429, no side effect (RATE-001); Redis degraded → fail-soft with DB-side T-042 cap intact (RATE-002); Redis never holds financial or authority state.
- AC11.4 **Registration/onboarding:** creates role-`ACCOUNT_HOLDER` users only, with no accounts/grants/money authority (REG-001); ADMIN provisioning remains bootstrap-only (AC1.5 amendment provenance recorded).
- AC11.5 **First-admin bootstrap script executable** (BOOT-001) and refusing re-run (BOOT-002, approved decision 12); distinct audited rotation unchanged.
- AC11.6 **Production role verification** before P4.8: host supports second role; `ledgerline_app` boundary identical through both clients (PRODROLE-001; H-4).
- AC11.7 **Health checks:** `/health` liveness credential-free; `/ready` reports PostgreSQL + Redis (HEALTH-001).
- AC11.8 **Deployment readiness** evidence (DEPLOY-001) at the P4.8 window.
- Tests: RATE-001/002, REG-001/002, BOOT-001/002, PRODROLE-001, PRISMA-001, TX-BOUNDARY-001, HEALTH-001, DEPLOY-001, T-060/061/062 controls.
