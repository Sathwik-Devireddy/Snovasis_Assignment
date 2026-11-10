# Project Brief — LedgerLine

## Product statement

LedgerLine moves money between accounts while preserving the books, preventing duplicate execution, resisting concurrent overspending and retaining trustworthy evidence of what happened.

## Problem being solved

Financial operations can fail through partial transfers, retries after timeouts, simultaneous withdrawals, unauthorized access and tampering with historical records. The system must make these conditions safe at the server/database boundary.

## In-scope requirements

1. Authentication with at least three roles: administrator, account holder and read-only auditor.
2. Create accounts; view balances and statements.
3. Deposits (external deposits are **ADMIN-only** per approved decision H-2), withdrawals and transfers.
4. Conservation invariant: internal transfers net to zero; customer-account totals change only through external deposits/withdrawals.
5. No account becomes negative unless a deliberate overdraft policy is documented and enforced server-side. The recommended initial scope is **no overdraft**.
6. Idempotency: same client key and same request returns the first result without repeating movement.
7. Concurrency safety: simultaneous requests cannot overspend or corrupt ledger/balances.
8. Per-account statement includes every debit, credit and refused attempt, resulting running balance and initiator.
9. Server-side per-account authorization for each action.
10. Automated tests prove conservation, concurrent no-overdraft, idempotent replay and cross-user authorization.

## Roles — proposed baseline

| Role | Allowed actions | Explicit restrictions |
|---|---|---|
| Administrator | Manage users/accounts and permissions; view system activity; perform only explicitly approved administrative operations | Cannot edit/delete ledger history; any adjustment must be a new, explained, balanced posting |
| Account holder | View permitted accounts/statements; withdraw/transfer only where assigned permission allows | **Cannot deposit** (H-2: external deposits are ADMIN-only); cannot access another user's account or grant self permissions |
| Auditor | Read-only access to permitted accounts, statements, transaction details and audit records | No money movement, permission changes or ledger mutation |

The exact permissions must be documented in an authorization matrix and enforced by the API, not just the UI. Approved decision **H-2** (2026-11-06, reaffirmed in the 2026-11-07 Gate 2 decision set): external deposits are **ADMIN-only** — account holders are never granted a `DEPOSIT` permission in v1 (`docs/AUTHZ_MATRIX.md` §A/§B); admin `ADJUSTMENT` posting is **deferred under H-5** and is not an active v1 capability.

## Core invariants

- **I1 — Balanced postings:** every posted journal transaction balances according to the chosen debit/credit convention, including a clearing/control account for external money movement where needed.
- **I2 — Customer balance conservation:** for an internal transfer, sender decrease equals receiver increase in the same committed transaction.
- **I3 — No overdraft:** available balance never becomes negative under any concurrent execution path.
- **I4 — Exactly-once effect per key:** one scoped idempotency key can cause at most one committed money movement.
- **I5 — Payload binding:** reusing a key with a different canonical request payload is rejected.
- **I6 — Authorization:** every operation checks the authenticated actor's permission for the relevant account and action.
- **I7 — Append-only history:** posted ledger entries are never updated or deleted through the application. Fixes are compensating entries.
- **I8 — Auditability:** a statement can identify posting type, amount, resulting balance, initiator, timestamp and status/refusal reason appropriate to the actor's access level.

## Out of scope for the first safe release

- Real-world bank/payment rails or real customer money.
- Multiple currencies unless the complete currency model and tests are deliberately added.
- Interest, overdraft, fees, scheduled/batch payments, payment holds and refunds unless time permits after the mandatory requirements are proven.
- AI deciding or executing transfers.
- Microservices, Kafka, distributed transactions or unnecessary infrastructure.

## Success criteria

A clean clone can be configured, migrated, seeded and run from documented instructions. A deployed demo supports all three roles. Automated tests exercise the actual PostgreSQL transaction and concurrency behavior. The repository contains a truthful threat register, dated AI-use record, API documentation, demo and honest limitations.
