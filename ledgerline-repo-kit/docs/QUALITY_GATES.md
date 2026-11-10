# Quality Gates and Definition of Done

## Global definition of done

A feature is complete only when:

1. Acceptance criteria are written and met.
2. Backend authorization and validation exist where relevant.
3. Database constraints protect invariants where possible.
4. Tests cover success, refusal, boundary conditions and relevant races.
5. The tests have actually run and the result is recorded.
6. Frontend states cover loading, empty, pending, success, error and retry where relevant.
7. Documentation, API contract and threat register are current.
8. No secret or unsafe default is introduced.
9. The human reviewer can explain the implementation.

## Financial-integrity gates

- [ ] All money values use integer minor units.
- [ ] Internal transfer creates balanced postings in one DB transaction.
- [ ] A journal with zero or one entry, or unbalanced/cross-currency totals, is rejected at COMMIT by the deferred trigger pair (`assert_journal_balanced()`, JBL-001) and leaves zero partial rows.
- [ ] Any exception between debit/credit rolls back all financial changes.
- [ ] No-overdraft is enforced atomically at the database/service boundary.
- [ ] Concurrency test uses independent database connections/transactions.
- [ ] Same-key retry produces one financial effect and the same stored outcome.
- [ ] Same key with a different payload is rejected.
- [ ] Account authorization is checked server-side for every request.
- [ ] Ledger mutation by application DB role is rejected.
- [ ] Statement running balances reconcile with postings and include required refused attempts.

## Test layers

- Unit tests: pure domain calculations, payload normalization, validation and permission policy.
- Integration tests: services + real PostgreSQL transactions, constraints, locks and migrations.
- API tests: authentication, role/account authorization, status/error contract and response shape.
- Concurrency tests: parallel withdrawals, parallel duplicate idempotency keys, opposite-direction transfers and failure/rollback paths.
- UI tests: key user flows and role-specific visibility; never use these as proof of backend security.
- Live smoke tests: deployed login, account view, transfer, statement and role access using synthetic demo accounts.

## Required adversarial tests

| Test ID | Scenario | Required evidence |
|---|---|---|
| FIN-001 | Transfer conserves customer funds | Before/after balances and ledger entries reconcile |
| FIN-002 | Transfer fails between debit and credit | No partial financial mutation remains |
| CON-001 | Two withdrawals race against insufficient combined balance | At most one succeeds; final balance never negative |
| CON-002 | Opposite-direction transfers race | No corruption; deadlock is avoided or safely retried |
| IDEM-001 | Same request/key submitted twice | One journal transaction; second response replays first |
| IDEM-002 | Same key, changed amount/recipient | Conflict; no second movement |
| IDEM-003 | Same key arrives concurrently | One execution; stored result is replayed |
| AUTH-001 | User attempts another account's transfer | Rejected; no balance or ledger mutation |
| AUTH-002 | Auditor tries money movement | Rejected |
| LED-001 | Runtime DB role updates/deletes ledger row | Database rejects operation |
| AUD-001 | Refused attempt appears in permitted statement/audit view | Actor/time/reason/status are accurate |

## Mutation testing expectation

For key integrity checks, temporarily remove one protection locally (for example, the lock or conditional balance guard) and verify the corresponding test fails. Restore the code immediately and verify the test passes. Do not commit a deliberately weakened implementation. Record what was removed and the test result in the engineering notes.

## Release gate

No release candidate unless migrations work from a clean database, tests pass against PostgreSQL, secrets are host-managed, demo credentials are synthetic, and critical threats are either mitigated with evidence or honestly disclosed.
