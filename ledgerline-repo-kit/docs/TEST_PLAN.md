# TEST_PLAN.md — Planned test files and coverage map (P2.6)

- **Phase:** 2 · **Date:** 2026-11-06 · **Status:** Draft for Gate 2 review
- All money-touching tests run against **real PostgreSQL** (docker-compose service locally, service container in CI). No DB mocks for integration/concurrency tests. Concurrency tests use **independent connections/transactions**, not parallelism inside one connection.

## Layout (mirrors D-2 layering)

```text
apps/api/test/
  helpers/            db.ts (pool/role fixtures), money.ts, assertGlobalInvariants.ts, seed.ts
  unit/               pure domain — no DB
  integration/        services + real PostgreSQL
  concurrency/        independent connections, forced races
  api/                HTTP contract: auth, authz matrix, statuses, shapes, redaction
  e2e/ (Phase 11)     Playwright smoke — never proof of backend security
```

## Files → threats / requirements covered

### test/unit/
| File | Covers | Test IDs |
|---|---|---|
| `domain/money.test.ts` | BigInt arithmetic from raw integer tokens, cap checks, formatting; tokens beyond 2^63 rejected before any conversion; no `Number` conversion anywhere in the money path | AMT-001, T-023, T-049 |
| `domain/journal.test.ts` | Balanced journal building (deposits/withdrawals/transfers), refusal before posting | FIN-001 concept, T-013 |
| `domain/requestHash.test.ts` | Canonical payload normalisation + hash stability/equality | IDEM-002/004 concept, T-004 |
| `policy/authorisation.test.ts` | Matrix table mirrored from `docs/AUTHZ_MATRIX.md` | AUTH-001..004 concepts |
| `validation/amount.test.ts` | Raw-token grammar (integer literal only), direct lossless `BigInt(tokenString)` conversion (never via `Number`), signed-64-bit range check, cap/`≤0` → business `INVALID_AMOUNT` | AMT-001, T-008, T-049 |

### test/integration/
| File | Covers | Test IDs |
|---|---|---|
| `migrations.test.ts` | Clean migrate up; roles exist; runtime role privileges | LED-001, LED-002 |
| `depositWithdraw.test.ts` | Journal balance vs clearing, cached balance consistency | FIN-001, T-013, CON-004 basis |
| `journalBalance.test.ts` | **Deferred journal-balance triggers at real COMMIT** (JBL-001, ADR-002): zero-entry journal rejected at COMMIT (the `journal_transactions` deferred trigger fires with no entries — a trigger on entries alone cannot catch it); one-entry journal rejected; unbalanced journal rejected; balanced two-entry and multi-entry journals commit; currency-inconsistent journal rejected; rejection aborts the whole transaction leaving zero journal/entry/balance rows (asserted per case); expected SQLSTATE on rejection = the trigger's `RAISE EXCEPTION` (P0001); exact scenario list in `ADR-002` Verification | JBL-001, FIN-001/002 basis, INV-001 |
| `transfer.test.ts` | Single transfer correctness; statement entries updated | FIN-001 |
| `transferFaultInjection.test.ts` | Abort between debit and credit; nothing moved | FIN-002, INF-001 |
| `idempotencyReplay.test.ts` | Success replay, refusal replay, hash mismatch; **replay re-evaluation gate** (row 7 / IDEM-006): revoked or expired session → **401 `UNAUTHENTICATED`** before any stored body; revoked grant / lost visibility → the uniform **404 `ACCOUNT_NOT_FOUND`** envelope; still-visible suspended/closed account → **409 `ACCOUNT_NOT_ACTIVE`**; gate pass → stored body with `replayed: true` (semantic replay — same status and business field values, **not byte-identical** JSONB: ADR-004 §1a); the replay's own envelope difference from the first response is exactly the `replayed: true` field; the gate pass and all **post-claim** refusals (`KEY_REUSED`, gate stage (c)) are evaluation-only — no new attempt rows, no counter bump; the **pre-claim** step-1b authorisation refusal is audited per D-9 regardless of whether the scoped key has committed history — **one audited FORBIDDEN row per refused replay retry — one insert attempted, exactly one durable row when persistence succeeds; a failed insert is logged and never suppresses the refusal** (REPLAY-AUTHZ-001; approved DEC-2) — and a revoked-session 401 writes no attempt row | IDEM-001, IDEM-002, IDEM-006, RET-001, REPLAY-AUTHZ-001 |
| `attempts.test.ts` | Refused rows survive transaction scenarios; merged statement inputs: locked `REFUSED` rows carry the allocated `account_event_seq` (from `accounts.event_last_seq`), pre-lock/authorisation rows carry `account_event_seq = NULL`; balance-availability matrix (NULL where pre-lock); **nonexistent-account persistence**: verbatim supplied id, NULL FK/seq/balance, uniform envelope unchanged | AUD-001, AUD-002, AUTH-009, STMT-002 |
| `appendOnly.test.ts` | Runtime UPDATE/DELETE/TRUNCATE rejected; trigger raises; the **same statements as `ledgerline_owner` are trigger-rejected too** (migrations are DDL — never blocked by these triggers; sole bypass = explicit `ALTER TABLE … DISABLE TRIGGER`, the disclosed residual); accounts-grant boundary (column-level UPDATE list only) | LED-001, LED-002, T-009 |
| `invariants.test.ts` | Σ debits = Σ credits; stored = derived balances; no negatives; **shared-counter gap-freeness**: union of `ledger_entries.account_event_seq` and locked-`REFUSED` `transaction_attempts.account_event_seq` per account gap-free, monotonic and equal to 1..`accounts.event_last_seq`; `global_seq` deliberately non-gap-free (strictly-moving only) | INV-001, T-037 |
| `grants.test.ts` | Grant/revoke lifecycle, audit events, self-grant rejection | AUTH-004, T-041 basis |
| `accounts.test.ts` | Creation (admin-only), status lifecycle per §F: all enum transitions, audited, **SUSPENDED blocks both credits and debits (SUS-001)**, `CLOSED` refuses money movement, reopen refused, close refused at non-zero balance with the zero-balance check under the account lock (`NONZERO_BALANCE`), active-CUSTOMER enforcement on money targets | T-012, DEST-001, SUS-001, AUTHORISATION AC2.4 |
| `seedIdempotency.test.ts` | Seeding twice doesn't double-post; bootstrap-create is single-run | SEED-001, T-044, T-045 |
| `destinationChecks.test.ts` | SYSTEM destination refused internally (exact reason); closed/suspended destinations refused; external envelope per target-visibility rule (uniform 404 to holders; granular 409 to admin cash-desk) | DEST-001, T-043, T-040, T-020 |

### test/concurrency/ (separate connections per actor)
| File | Covers | Test IDs |
|---|---|---|
| `withdrawalRace.test.ts` | N concurrent withdrawals, insufficient total | CON-001, T-001 |
| `transferOppositeDirections.test.ts` | A→B vs B→A; deadlock-free or retried | CON-002, T-010 |
| `sameKeyRace.test.ts` | Duplicate key, separate connections | IDEM-003, T-005 |
| `concurrentDeposits.test.ts` | Many deposits — no global serialisation via clearing | CON-004, T-022 |
| `revocationRace.test.ts` | Revoke while transfer in flight (forced overlap hook) | AUTH-008, T-041 |
| `roleChangeRace.test.ts` | Role change / disabling races an in-flight transfer; forced overlap via hook; sessions of the changed user revoked; exactly two legal orders | ROLE-001, T-046 |
| `lastAdminRace.test.ts` | **Real race**: two independent connections demote two different administrators simultaneously; serialised on `admin_control` `FOR UPDATE`; loser sees post-commit re-count and is refused; ≥1 active admin always remains | ADMIN-002, T-047 |
| `sessionRevokeRace.test.ts` | Logout / session-revoke races an in-flight transfer (forced overlap): revocation is exactly `UPDATE sessions SET revoked_at = now()` taken `FOR UPDATE`; money command re-reads the session row `FOR SHARE` inside its transaction and validates the single active-session predicate (`revoked_at IS NULL AND expires_at > now()`); exactly two legal orders; post-revocation calls 401; replay after logout refused | SESS-001, T-048 |
| `replayAfterRevoke.test.ts` | Replay post-revocation/suspension refused per the **write-site map** (`REPLAY-AUTHZ-001`; DEC-1 scope, approved 2026-11-09): revoked grant / lost visibility → refused at **D-8 step 1b, before the key row is read** → the uniform 404 envelope **plus one audited FORBIDDEN attempt row per refused retry — one insert attempted, exactly one durable row when persistence succeeds; a failed insert is logged and never suppresses the refusal** (D-9/AUD-002/AUTH-009, key-state-independent: NULL balance/seq, verbatim `supplied_account_ref`, T-042 caps the volume); suspended-/closed-but-still-visible → 409 `ACCOUNT_NOT_ACTIVE` at gate stage (c) — **nothing stored changes on this gate refusal** (no attempt row, no counter bump); a different-payload retry by the same now-unauthorised caller returns the 404 envelope, **never** `KEY_REUSED` (authorisation precedes the key row); missing/expired/revoked session → 401 with **no** attempt row (deliberate F-3 asymmetry, asserted both sides); the gate's `FOR SHARE` account re-read follows the declared lock order (no new lock class, no cycle) and serialises with a concurrent suspension/closure — **exactly two legal orders** | IDEM-006, REPLAY-AUTHZ-001, T-028 |

### test/api/
| File | Covers | Test IDs |
|---|---|---|
| `auth.api.test.ts` | Login, uniform errors, rate limit, logout, cookie flags | AUTH-005, AUTH-006, T-031, T-032 |
| `amounts.api.test.ts` | HTTP-boundary amount validation: raw-token grammar (400 shapes), signed-64-bit range (400), `≤0`/cap (409 business), string serialisation of money fields in responses; no silent IEEE-754 rounding (token `9007199254740993`-class inputs) | AMT-001, T-008, T-049 |
| `statements.api.test.ts` | Statement shape: **one merged `timeline`** — every row categorized `event`/`attempt`; event rows ordered by `account_event_seq`, attempt rows unsequenced (`event_position: null`) by `(occurred_at, global_seq)`; deterministic head-first interleave of the two pre-ordered lists (earlier `occurred_at` first; exact tie → event first) — **within-category order preserved even with skewed/non-monotonic `occurred_at` data** (fixture where a transaction started earlier but bumped later after a lock wait); **no fabricated sequence positions** for attempt rows (asserted both ways: relative orders preserved, no null-category/`account_event_seq` leak); running balance from postings only; FAILED rows absent; balances NULL where unmeasured; money/sequence fields serialised as JSON strings | STMT-001, STMT-002, AUD-001 |
| `timing.api.test.ts` | **Best-effort statistical timing check (non-blocking, approved decision 7 — NOT a required CI pass criterion; failing tolerance must not gate the build)** of the uniform envelope: fixed sample (e.g. 200 calls) across three cases (account exists+forbidden / exists+invisible / absent); asserts documented tolerance (median difference bound, no consistent monotonic signal) — mitigation evidence, not a latency guarantee | TIMING-001 |
| `crossUser.api.test.ts` | Cross-account writes/reads; **identical 404 envelope** for FORBIDDEN and missing account; destination classification (SYSTEM kind/status) never disclosed to non-account-visible callers; **`account_status_detail` never present in any response to a holder** (ASD-001, across suspended/closed/nonexistent/SYSTEM cases); latency verified separately and statistically in `timing.api.test.ts` | AUTH-001, AUTH-007, ASD-001, DEST-001, T-006, T-016, T-020 |
| `roles.api.test.ts` | Auditor write attempts; holder attempts deposit | AUTH-002, AUTH-003, T-024 |
| `selfGrant.api.test.ts` | Admin self-grant blocked; grant audit trail | AUTH-004, T-025 |
| `userLifecycle.api.test.ts` | Last-admin guard (`LAST_ADMIN_PROTECTED`, sequential), **bootstrap disabled once an administrator exists (approved decision 12; no override path through bootstrap)**, separate audited rotation procedure (env-sourced operator id — CLI-only refusation, confirmation phrase, CI refusal by default, distinct `admin_credential_rotation` audit event with claimed operator + invocation context, same-transaction session revocation), role-change session revocation, admin session-revoke of users | ADMIN-001, T-045, T-046 |
| `redaction.api.test.ts` | No secrets/tokens in logs, errors, or responses | LOG-001, T-015 |

## Standing helpers

- `assertGlobalInvariants(db)` runs at the **end of every** integration and concurrency test: all journals balance, every customer balance equals its ledger sum and is ≥ 0, Σ customer balances = − clearing balance.
- Mutation checks (Phase 12) list: (a) remove row lock → CON-001 must fail; (b) reverse lock order → CON-002 must fail; (c) drop unique constraint on idempotency key → IDEM-003 must fail; (d) weaken authorisation check → AUTH-001 must fail; (e) drop the `admin_control` singleton serialisation → ADMIN-002 must fail (two concurrent demotions both succeed, zero admins); (f) drop the in-transaction session `FOR SHARE` re-read → SESS-001 must allow a post-logout command (three-ish orderings); (g) disable/replace the `FOR UPDATE` on `admin_control` with `FOR SHARE` → ADMIN-002 must fail (share locks do not conflict with each other); (h) disable the deferred journal-balance triggers → JBL-001 must fail (a zero-entry journal would commit); (i) import Prisma into a money-path module or open a second pool inside a financial operation → `TX-BOUNDARY-001` (architecture guard, T-062) must fail the build.

## BalanceVault expansion — planned test files (2026-11-09, additive)

Registered IDs (ACCEPTANCE.md R11): RATE-001/002, REG-001/002, BOOT-001/002, PRODROLE-001, PRISMA-001, TX-BOUNDARY-001, HEALTH-001, DEPLOY-001.

### test/api/
| File | Covers | Test IDs |
|---|---|---|
| `rateLimit.api.test.ts` | Redis-backed per-actor (session identity, IP pre-auth) limiter on register/login and money endpoints; over-limit → `429 RATE_LIMITED` with **zero side effect** (money unchanged, no attempt row, no user row); env-configured thresholds; money operations keep idempotency semantics when limited (key unconsumed) | RATE-001 |
| `register.api.test.ts` | `POST /register`: creates role-`ACCOUNT_HOLDER` user only (role never accepted from request); **no accounts/grants/money authority** — every account/money/admin call by the fresh registrant is refused per the matrix; duplicate email → uniform error, no enumeration; argon2id storage; login/logout reuses the P5.3 session rules | REG-001, REG-002 |
| `health.api.test.ts` | `/health` liveness credential-free; `/ready` reports failure (not ok) on PostgreSQL unreachability and on Redis unreachability; readiness recovers when components return; no env/credential leakage in either endpoint | HEALTH-001 |

### test/integration/
| File | Covers | Test IDs |
|---|---|---|
| `bootstrapScript.test.ts` | Executable bootstrap host command: creates the first ADMIN from env secret (argon2id), emits `bootstrap_created` audit event, password never stored; **re-run refuses once an ADMIN exists** (approved decision 12; no override); rotation path unchanged (`admin_credential_rotation`, env-sourced operator) | BOOT-001, BOOT-002 |
| `prismaBoundary.test.ts` | Prisma connects under `ledgerline_app` to the same database; routine CRUD works through Prisma; LED-001/LED-002 privilege statements fail identically through Prisma as through `pg`; schema introspection === migrated schema (no drift); money-path modules contain no Prisma import (architecture guard) | PRODROLE-001 (harness), PRISMA-001, TX-BOUNDARY-001 |

### Verification note (DEPLOY-001)

DEPLOY-001 is a **deployment-window checklist**, not a unit test: documented deploy commands bring up API + PostgreSQL + Redis; secrets from host env only; `/health` verified from an external network (P4.8, mirrors the existing phone-on-another-network check); PRODROLE-001 recorded before the window. Evidence is the recorded command output, committed at gate time.
