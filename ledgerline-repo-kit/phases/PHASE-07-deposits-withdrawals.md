# Phase 7: Money command runner, deposits and withdrawals

**Target:** Sun 8 Nov. **Agents:** 05 backend, 08 QA, 07 security. **Skills:** idempotent-money-command, ledger-posting, concurrency-test-writing.

## Objective
One reusable `moneyCommandRunner` that owns transaction, idempotency claim, locking and refusal recording, then deposits and withdrawals on top of it. Getting transaction boundaries right here prevents retrofitting later.

## Tasks
- [ ] P7.1 `application/moneyCommandRunner`: begin; authorise in-transaction (`FOR SHARE` grants; on refusal roll back and write the audit attempt separately); claim key (`INSERT … ON CONFLICT DO NOTHING`); run the use case; store response; commit. Business refusals commit a REFUSED attempt; infrastructure errors roll back. Retry only on 40P01/40001, same key.
- [ ] P7.2 `Idempotency-Key` header required (400 if missing or malformed); canonical request hash in `domain/`.
- [ ] P7.3 `depositMoney` use case: **admin-only external deposit (decision H-2 — no holder ever receives a DEPOSIT grant in v1; see `AUTHZ_MATRIX.md` §A/§B)**; debit clearing, credit customer; lock account row (not clearing).
- [ ] P7.4 `withdrawMoney` use case: WITHDRAW permission; lock, read balance after lock, refuse if insufficient.
- [ ] P7.5 Endpoints per `docs/API_CONTRACT.md`; thin handlers; typed errors mapped once.
- [ ] P7.6 Refusals recorded for: insufficient funds, inactive account, invalid amount, forbidden (AUD-002).
- [ ] P7.7 Tests: boundaries (0, negative, 1.5, string, huge, 2^53+1), rollback with injected failure (FIN-002 analogue), AUTH-003 holder cannot deposit, replay basics.
- [ ] P7.8 **CON-001:** two withdrawals racing on insufficient combined balance. At most one succeeds; final balance correct; one journal; both attempts visible.
- [ ] P7.9 **CON-004:** 50 concurrent deposits to different and same accounts finish with exact totals and no stall.
- [ ] P7.10 **Deferred under H-5 (not before Gate 9 — not an active v1 capability):** admin `ADJUSTMENT` (balanced journal against an `ADJUSTMENT` system account, mandatory reason, ADJUST grant, cannot drive balance negative).

## Acceptance (Gate 7)
Tests pass; `assertGlobalInvariants` runs after each; race tests use independent connections and a barrier.

## Closeout
Update T-001, T-008, T-018, T-021, T-022, T-023, T-024. `PROMPTS.md` entry (integrity/concurrency).
Suggested commits: `feat(app): money command runner`, `feat(deposit): …`, `feat(withdraw): …`, `test(concurrency): racing withdrawals`.
