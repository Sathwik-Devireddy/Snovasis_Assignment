# Financial Integrity Evidence — Phase 3

*Date: 2026-11-14 · Baseline: `main` @ `66f2b29`*

This document maps each financial invariant to its concrete evidence and
distinguishes the verification level of each claim:

- **Verified through automated tests** — executed by this phase or CI, real PostgreSQL + Redis.
- **Verified locally (live probes)** — read-only SQL probes executed by this phase against the accumulated local Docker database.
- **Verified in production** — non-destructive HTTPS probes / Phase 2 browser journeys.
- **Implemented — not independently verified** — code exists, no separate evidence produced this phase.
- **Blocked pending human action** — production deposit journey.

## 1. Live invariant probes (this phase, read-only)

Environment: local Docker PostgreSQL 17 (`127.0.0.1:15432`, database
`balancevault`) — the accumulated local database holding ~850 customer
accounts and the demo/qa history, **not** production. All probes read-only
(`psql` via `docker exec` as the bootstrap role; no data printed except aggregates).

| Probe | SQL summary | Result |
|---|---|---|
| Journal balance (I1) | Per-journal `SUM(DEBIT) = SUM(CREDIT)` over all `ledger_entries` | **7,348 journals, 0 unbalanced** |
| Stored vs ledger-derived balance | Per customer account: `accounts.balance_minor` vs `Σcredits − Σdebits` | **850 customer accounts, 0 mismatches** |
| Event-counter integrity | Per account: allocated `account_event_seq` count = `event_last_seq` and Σseq = n(n+1)/2 (postings + locked refusals) | **0 mismatches across all accounts** |
| Global conservation | `Σ customer derived + Σ system(clearing) derived = 0` | **customer_total 18,671,344 + clearing −18,671,344 = 0** — exact |

Method note (honesty): the first counter probe returned 121 "mismatches";
that was a NULL-handling defect **in the ad-hoc probe itself** (accounts with
`event_last_seq = 0` and no allocated rows compared against a NULL LEFT-JOIN
aggregate). Re-run with `COALESCE` matching the exact computation in
`reconciliation.ts`, the result is 0. The probe was corrected; no code changed.

These probes exercise real accumulated history (seed data + Phase 2 journeys:
7,348 journal transactions), which is complementary to — not a substitute for —
the deterministic test suite.

## 2. Invariant → automated-test evidence map

All API tests run against **real PostgreSQL 17 + Redis 8** (no mocks) via the
`test/harness.ts` (fresh random schema per file; concurrency tests use
`independentConnection()`); the API tier tests boot the real Fastify app in-process
(`buildApp` + `app.inject`). Phase 3 re-run: **26 files / 202 tests passed**
(see `PHASE_3_FINAL_REPORT.md` §Test results).

| Invariant / behaviour | Test file · test/ID | Phase 3 status |
|---|---|---|
| Balanced double-entry postings incl. zero/one-entry/unbalanced/cross-currency rejection at COMMIT | `test/integration/ledgerCore.test.ts` `JBL-001`; DB trigger pair `assert_journal_balanced` (migrations) | Verified through automated tests |
| Balances agree with ledger entries | `test/api/reconciliation.api.test.ts` (stored-vs-derived per account); `assertGlobalInvariants` in `test/api/reconciliationConservation.api.test.ts` | Verified through automated tests |
| Conservation: transfers net to zero; customer total changes only via external movement | `reconciliationConservation.api.test.ts` (delta-based assertion against a captured baseline) | Verified through automated tests |
| No overdraft under concurrency | `ledgerCore.test.ts` `CON-001` (exactly one of N concurrent over-balance withdrawals succeeds); **mutation M1** (`CON-001` fails without the CHECK) and **M3** (both succeed without the `FOR UPDATE` lock) executed in Phase 12 | Verified through automated tests |
| Withdrawals/transfers debit/credit correct accounts in one transaction | `test/api/money.api.test.ts`; `ledgerCore.test.ts` postings assertions | Verified through automated tests |
| Failed transactions leave no partial ledger entries | `ledgerCore.test.ts` rollback assertions; `moneyTimeoutClassification.api.test.ts` (57014 → 503, key not consumed, retry works; user-cancel → 500 `INFRA_FAILURE`) | Verified through automated tests |
| Idempotent replay returns stored result, no new movement | `ledgerCore.test.ts` `IDEM-003`/`IDEM-005` (lost-response replay); `money.api.test.ts` row 4; **verified live this phase by the seed re-run (§3)** | Verified through automated tests + local replay |
| Same key + different payload rejected (`KEY_REUSED`) | `money.api.test.ts` row 5 (`IDEM-002`); `ledgerCore.test.ts` | Verified through automated tests |
| Concurrent requests cannot double-spend | `CON-001..CON-004` (`ledgerCore.test.ts`: concurrent overdraw, opposite-direction transfers, same-key duplicates); deadlock/serialization retry ×3 with 55P03/57014 → 503 key-not-consumed | Verified through automated tests |
| Rollback preserves consistency | `ledgerCore.test.ts`; fault-injection timeout classification tests | Verified through automated tests |
| Audit events for sensitive operations | `auditAtomicity.api.test.ts` (user/register/login/logout/admin/grant rows commit atomically with their state change); `AUD-001` (refusal rows) in `statements.api.test.ts`; money-path refusals → `transaction_attempts` (D-9, by design — see `AUDIT_COVERAGE.md`) | Verified through automated tests |
| Reconciliation reports conservation and consistency accurately | `reconciliation.api.test.ts` + `reconciliationConservation.api.test.ts`; **live summary probe = exact conservation (§1)** | Verified through automated tests + local probe |
| Cross-user authorization | `crossUser.api.test.ts`, `grantsAuth.test.ts`, adversarial `A5` (holder deposit), `A1–A8` in `test/integration/phase12Adversarial.test.ts` | Verified through automated tests |

Append-only enforcement (I7) evidence: Phase 12 mutation checks M1/M2/M3 +
`LED-001/001b/002` role tests (runtime role denied UPDATE/DELETE/TRUNCATE;
triggers fire for the owner too) — recorded in `THREATS.md` revision 3.

## 3. Idempotent-seed determinism verified live (this phase)

`apps/api/scripts/seed-demo.mjs` re-run against the local API (:4000, Docker DB):

```
[seed-demo] demo.holder@balancevault.local already exists — skipped
[seed-demo] account DEMO-HOLDER-ACCOUNT already exists — skipped
[seed-demo] granted VIEW/TRANSFER/WITHDRAW on the demo accounts to the demo holder
[seed-demo] deposit (admin) → 200 {"status":"SUCCEEDED","journalTransactionId":"6236","replayed":true}
[seed-demo] transfer (holder) → 200 {"status":"SUCCEEDED","journalTransactionId":"6237","replayed":true}
```

Post-run check: balances unchanged (200,884 / 50,250 paise) and still exactly
7 ledger rows across the two demo accounts — the second run **replayed** the
fixed-key movements instead of double-posting (T-044 / SEED-001). This is the
same exactly-once machinery (I4) exercised on real accumulated state.

## 4. The money-path control chain (code reference)

One raw-`pg` transaction per money command (`domain/transactionRunner.ts`,
ADR-005; Prisma never opens a financial transaction — TX-BOUNDARY-001):

1. Session/actor re-read `FOR SHARE` (first in the lock order).
2. Involved accounts + grants re-read `FOR SHARE`, **ascending account id** (deterministic, deadlock-free).
3. Idempotency claim: `INSERT … ON CONFLICT DO NOTHING` on the UNIQUE `(actor_id, operation, idempotency_key)` — a concurrent twin **blocks on the uncommitted unique row**, then replays the stored result (no explicit key-row `FOR UPDATE`).
4. Same key + different canonical request hash → `409 KEY_REUSED` (payload binding, I5).
5. Account rows locked `FOR UPDATE` (ascending id) → balance checked **under the lock** (`INSUFFICIENT_FUNDS` refusal otherwise; backstop `CHECK (balance_minor >= 0)`).
6. Journal + two balanced ledger entries + cached-balance update + attempt row, one `COMMIT`; the deferred `assert_journal_balanced` trigger pair re-checks balance at COMMIT.
7. Business refusals commit a durable `transaction_attempts` row in their own transaction (T-042-capped, best-effort); infra failures (57014) map to 503 `LOCK_TIMEOUT` with the key **not consumed** — a retry safely reuses it.

## 5. Production financial-integrity posture

- Production contains **zero journals** (0 money movements) — there is no
  artificial or test financial data in production, by design.
- The **production deposit journey is `BLOCKED — awaiting owner-controlled
  real-admin bootstrap`** (the first-admin slot is deliberately reserved; this
  is an intentional security decision, not a defect). Until an ADMIN exists in
  production, no deposit can be posted there — deposits are ADMIN-only (H-2).
- Production verification was strictly non-destructive: health/readiness/
  authentication probes only (see `PHASE_3_FINAL_REPORT.md` §Deployment).
- Phase 2 verified withdrawals/transfers **locally** and the read-side
  (accounts, statements, audit, reconciliation) **in production** with the
  pre-existing production users; that evidence is not re-claimed as new here.

## 6. Honest limitations

- The 202-test suite covers invariant behaviour deterministically; the live
  probes add coverage of *accumulated real history*. Neither can prove the
  absence of every defect; the strongest residual risks are the disclosed
  ones in `THREATS.md` (T-017/T-018/T-020/T-038/T-063 OPEN, T-050 ACCEPTED).
- Production has no financial history to probe (0 journals), so conservation
  *in production* is trivially true and untested with real movement until the
  owner bootstrap completes.
- The statement merge and pagination behaviours are verified through
  automated tests; they were additionally exercised manually in the Phase 2
  production journey, which is browser-level evidence, not a repeatable suite.
