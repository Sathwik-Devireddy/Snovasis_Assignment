# Phase 8: Internal transfers and concurrency

**Target:** Sun 8 to Mon 9 Nov. **Agents:** 05 backend, 04 database, 08 QA. **Skills:** concurrency-test-writing, mutation-check, ledger-posting.

## Tasks
- [ ] P8.1 `transferMoney`: reject same account; TRANSFER permission on source; destination must be active; uniform error for inaccessible destination (AUTH-007).
- [ ] P8.2 Read and `FOR SHARE`-lock the actor's grant rows first (ADR-007), then lock **both** customer accounts in ascending id order in one statement (`ORDER BY id FOR UPDATE`).
- [ ] P8.3 Balance read after locks; refuse when insufficient; write two entries, both balances, both `account_event_seq` values, in the same transaction.
- [ ] P8.4 **FIN-001:** transfer conserves funds; ledger reconciles.
- [ ] P8.5 **FIN-002:** injected failure between debit and credit leaves nothing changed.
- [ ] P8.6 **CON-002:** many A→B and B→A transfers concurrently; no deadlock failures surface, totals exact.
- [ ] P8.7 **CON-003:** force a deadlock/serialization error; runner retries with the same key; exactly one effect.
- [ ] P8.8 Many parallel transfers from one account to many; sum of successes ≤ balance; final balance ≥ 0.
- [ ] P8.9 **Mutation check A (lost update):** remove `FOR UPDATE` on the account rows. CON-001 and the parallel-transfers-from-one-account test (P8.8) must FAIL (overdraft or lost update). Restore; record. Note that CON-002 is *not* expected to fail here: without locks there is nothing to deadlock on.
- [ ] P8.10 **Mutation check B (deadlock):** keep the locks but lock the two accounts in source-then-destination order instead of ascending id. CON-002 must FAIL by surfacing a deadlock (`40P01`) in a forced-overlap run, using a test hook that pauses after the first lock. Restore; record.
- [ ] P8.11 **AUTH-008:** a revocation racing an in-flight transfer is linearised (ADR-007): revocation waits for the transfer to commit, and a transfer started after the revocation committed is refused.

## Acceptance (Gate 8)
Each protection has its own mutation experiment (A: lock removal, B: lock-order reversal) and you have seen the matching test fail and pass.

## Closeout
Update T-001, T-002, T-010, T-029, T-040, T-041. `PROMPTS.md` entry (concurrency) with the real mutation experiment.
Suggested commits: `feat(transfer): …`, `test(concurrency): opposite-direction transfers`.
