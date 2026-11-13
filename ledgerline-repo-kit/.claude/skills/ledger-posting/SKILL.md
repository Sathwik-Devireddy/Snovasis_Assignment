---
name: ledger-posting
description: Rules for writing journals and ledger entries in LedgerLine: double-entry, credit-normal balances, clearing account, balance_after, append-only. Use for any code or migration touching money tables.
---
# Ledger posting rules

- Amounts are `BIGINT` minor units; `BigInt` in TypeScript. `pg` returns BIGINT as a string, so convert at the infrastructure edge. Never `Number` for sums. In JSON responses (and stored replay bodies) every money/sequence integer is serialised as a **string**, never a bare number (`docs/API_CONTRACT.md` / `REFUSAL_CODES.md` §2).
- Every movement is one `journal_transactions` row plus ≥2 `ledger_entries` with `direction` DEBIT|CREDIT and `amount_minor > 0`. Σ debits = Σ credits per journal, in one consistent currency, built by the pure domain builder **and** enforced by the deferred constraint-trigger pair sharing `assert_journal_balanced()` — anchored on BOTH `journal_transactions` (catches even a zero-entry journal at COMMIT) and `ledger_entries` (`docs/schema-draft.sql`; ADR-002; test JBL-001).
- Customer balance = Σ credits − Σ debits. Deposit: debit `EXTERNAL_CLEARING`, credit customer. Withdrawal: reverse. Transfer: debit source, credit destination.
- Accounts have `kind` CUSTOMER or SYSTEM. Only CUSTOMER rows hold a cached balance (`>= 0`). The clearing/adjustment SYSTEM accounts are **never locked and never cached**; their balance is ledger-derived and may be negative; their entries have NULL `balance_after` and `account_event_seq`.
- Customer entries store `balance_after_minor` and `account_event_seq` allocated under the account row lock by bumping `accounts.event_last_seq` (approved Gate 2 naming).
- `accounts.balance_minor` is a cache with `CHECK >= 0`, updated only in the same transaction as the entries.
- Ledger tables are append-only: no UPDATE/DELETE/TRUNCATE for the runtime role, plus triggers. Corrections are new compensating journals.
- Refusals are **not** postings; they are rows in `transaction_attempts`.
- Review checklist: can a debit commit without its credit? can a statement be rebuilt from entries alone? is any amount computed with float? is the balance read **after** the lock?
