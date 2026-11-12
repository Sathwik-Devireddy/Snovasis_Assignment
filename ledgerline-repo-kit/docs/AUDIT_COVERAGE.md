# Audit Coverage Matrix

Every state-changing operation in BalanceVault, the audit event it writes, the
transaction boundary that binds the two together, and what happens when the
audit write fails.

Last verified: master-stabilisation (Stage B + Stage C).

## Rule

> A state change and its audit event commit TOGETHER or roll back TOGETHER.

The only exception is an **audit-only** path (no state change to protect) — it
is written best-effort and its failure is logged, never surfaced to the
caller.

## Matrix

| Operation | State changed | Audit event | Transaction boundary | Failure behaviour |
|---|---|---|---|---|
| `POST /register` | `users` row (role fixed to `ACCOUNT_HOLDER`) | `USER_REGISTERED` | ONE Prisma interactive transaction (`register.ts`) | Audit failure → 500 `INFRA_FAILURE`, **user row rolled back** (no half-registered account) |
| `POST /login` (success) | `sessions` row (opaque token, hashed at rest) | `LOGIN_SUCCEEDED` | ONE Prisma interactive transaction (`auth.ts`) | Audit failure → 500, **session row rolled back** (no session without its audit trail) |
| `POST /login` (failure) | none (audit only) | `LOGIN_FAILED` | single autocommit insert, best-effort | Insert failure → logged as a warning; the caller still receives the uniform 401 (AUTH-005 uniformity is never degraded) |
| `POST /logout` | `sessions.revoked_at` | `SESSION_REVOKED` | ONE Prisma batch transaction (`auth.ts`) | Audit failure → 500 `INFRA_FAILURE`, **revocation rolled back** — the session stays valid and the UI must NOT claim success |
| `POST /users` (admin) | `users` row | `USER_CREATED` | ONE Prisma interactive transaction (`admin.ts`) | Audit failure → 500, **user row rolled back**; metadata carries no credential material |
| `PATCH /users/:id/role` | `users.role`, target sessions revoked | `role_changed` | ONE raw-`pg` transaction (existing owner of this route) | Any failure → `ROLLBACK`; the role change and the session revocations are undone together |
| `POST /account-permissions` | `account_permissions` row | `permission_granted` | ONE raw-`pg` transaction (existing owner) | Any failure → `ROLLBACK`; no grant without its audit row |
| `DELETE /account-permissions` | `account_permissions.revoked_at` | `permission_revoked` (with `revoked: true/false`) | ONE Prisma interactive transaction (`admin.ts`) | Audit failure → 500, **revocation rolled back** — the grant stays active |
| `POST /accounts/:id/deposits` | journal + 2 ledger entries + cached balance | `transaction_attempt`/journal refs (D-9 rows) | ONE raw-`pg` transaction (`transactionRunner.ts`) | Everything rolls back; the idempotency key is NOT consumed; a FAILED attempt row is written best-effort |
| `POST /accounts/:id/withdrawals` | as above | as above | as above | as above |
| `POST /transfers` | as above | as above | as above | as above |
| Money-path authorisation refusals | none (nothing moved) | `transaction_attempts` row `REFUSED` | separate best-effort transaction (D-9) | Never suppresses the caller-facing refusal |

## Money-path notes

* The money path is owned exclusively by raw `pg` (ADR-005). Prisma never
  participates in a financial transaction, and a financial operation is never
  split across a Prisma and a raw-pg transaction.
* `transaction_attempts` rows for infrastructure failures are **best-effort**
  (they are written in their own short transaction after the financial
  transaction rolled back). They never change the caller-visible outcome and
  never consume the idempotency key.
* The T-042 attempt-write cap is **best-effort**, not a strict hard cap: the
  count and the insert are not serialised by a lock. See
  `ledgerline-repo-kit/THREATS.md` (T-042) for the accepted limitation — the
  cap is an abuse guard, not a financial invariant.

## Coverage gaps (declared, not accidental)

* `GET`/read routes never write audit events (they change no state).
* The first-admin bootstrap writes `bootstrap_created` from the host script
  (`apps/api/scripts/bootstrap.mjs`) with system attribution
  (`actor_id = NULL`), not through the API.
* `rotate-admin-credentials` writes its own audit event from the host script
  and requires an operator claim.

## Regression tests

| Guarantee | Test |
|---|---|
| Registration audit failure rolls the user back | `apps/api/test/api/auditAtomicity.api.test.ts` |
| Login audit failure rolls the session back | `apps/api/test/api/auditAtomicity.api.test.ts` |
| Logout audit failure leaves the session active; retry succeeds | `apps/api/test/api/auditAtomicity.api.test.ts` |
| Admin user creation audit failure rolls back | `apps/api/test/api/auditAtomicity.api.test.ts` |
| Permission revocation audit failure leaves the grant active | `apps/api/test/api/auditAtomicity.api.test.ts` |
| `USER_CREATED` metadata contains no credential material | `apps/api/test/api/auditAtomicity.api.test.ts` |
