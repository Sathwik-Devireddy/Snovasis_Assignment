# Phase 6: Schema and ledger core

**Target:** Sat 7 Nov. **Agents:** 04 database/ledger, 05 backend. **Skills:** ledger-posting, clean-architecture-guard.

## Objective
The tables, constraints and posting service that make unbalanced or mutable ledgers impossible.

## Tasks
- [ ] P6.1 Migrations per ADR-002: `accounts` (`kind` CUSTOMER|SYSTEM; customer-only cached `balance_minor` with `>= 0`, cap and `event_last_seq`; system accounts have NULL balance, ledger-derived; status; currency), plus a test that a SYSTEM row cannot hold a cached balance, `journal_transactions`, `ledger_entries` (direction, `amount_minor > 0`, `balance_after_minor`, `account_event_seq`), `transaction_attempts`, `idempotency_records`.
- [ ] P6.2 System account `EXTERNAL_CLEARING` seeded; flagged so it is never locked or cached.
- [ ] P6.3 Append-only-era journal balance: deferred constraint triggers + named `assert_journal_balanced()` body (full definition in `docs/schema-draft.sql`) anchored on BOTH `journal_transactions` (catches zero-entry journals at COMMIT — a trigger on entries alone cannot) and `ledger_entries`; ≥ 2 entries, Σ debits = Σ credits, one consistent currency per journal, checked at COMMIT; violations roll back the whole transaction (test: `journalBalance.test.ts`, JBL-001).
- [ ] P6.4 Append-only: REVOKE UPDATE/DELETE/TRUNCATE from `ledgerline_app` on ledger tables, attempts, audit; row and TRUNCATE triggers.
- [ ] P6.5 `domain/money` (BigInt, parse, cap) and `domain/journal` (pure builder: command → balanced entries). Unit tests including 2^53±1.
- [ ] P6.6 `infrastructure/postingRepository`: insert journal and entries, update balance and `event_last_seq` (caller already holds locks).
- [ ] P6.7 `assertGlobalInvariants(db)` real implementation: balanced journals, stored = ledger-derived, none negative, conservation, per-account `account_event_seq` gap-free (union of postings and locked refusals, matching `REFUSAL_CODES.md` §5).
- [ ] P6.8 Tests: LED-001 (UPDATE/DELETE rejected as `ledgerline_app`), LED-002 (TRUNCATE rejected), unbalanced journal insert rejected by the DB, negative balance rejected by CHECK.
- [ ] P6.9 `POST /accounts` (admin) and `GET /accounts`, `GET /accounts/:id` with authorisation.

## Acceptance (Gate 6)
The tests above pass against PostgreSQL **using the runtime role**. Sign convention documented in code comments and ADR-002.

## Closeout
Update T-009, T-013, T-019, T-026, T-036. `PROMPTS.md` entry (integrity).
Suggested commits: `feat(db): ledger schema and constraints`, `feat(ledger): balanced journal builder`, `test(ledger): append-only and balance invariants`.
