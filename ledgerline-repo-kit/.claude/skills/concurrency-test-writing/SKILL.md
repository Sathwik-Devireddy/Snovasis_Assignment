---
name: concurrency-test-writing
description: How to write real race and retry tests for LedgerLine using independent PostgreSQL connections and barriers, asserting stored state. Use for CON-*, IDEM-* and FIN-* tests.
---
# Writing a real concurrency test

A test that calls an endpoint once and checks a balance is not a concurrency test.

- Use a real PostgreSQL database; never mock the repository or SQLite.
- Create N **independent** requests/connections (separate pool clients). Release them together behind a barrier (`Promise` latch or `Promise.all` after all are ready), and, where timing matters, a deliberate hook (`pg_sleep` or an awaited test hook after the lock) to force overlap.
- Assert **stored state**, not only HTTP codes: final balances; count of `journal_transactions`; count and sum of `ledger_entries`; attempts recorded; idempotency rows (one committed-outcome row per scoped key — a replay adds **no** rows: v1 has no replay counters or `IDEMPOTENT_REPLAY` audit events, `ADR-004` §4; the replay's trace is the `replayed: true` response field).
- Always finish with `assertGlobalInvariants(db)`.
- Run racy tests many times locally (loop 20-50) before trusting them; report flakiness honestly; never loosen an assertion to go green.
- Name tests with the threat/test ID (`CON-001 …`) so `THREATS.md` can cite them.
- Every key protection needs a mutation check (see `mutation-check`): remove the guard, the test must fail.
