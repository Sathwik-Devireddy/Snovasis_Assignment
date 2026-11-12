# API Reference — BalanceVault / LedgerLine

Per-endpoint contract: **who may call it, what it changes, whether it is
idempotent, which transaction owns it, what it does to the ledger, how it
refuses, and where it is tested**.

The normative envelope, error taxonomy and refusal codes live in
[`API_CONTRACT.md`](API_CONTRACT.md) and [`REFUSAL_CODES.md`](REFUSAL_CODES.md);
this file is the operational index of the implemented surface.

**Base URL:** same-origin `/api/*` from the web tier (the Next.js rewrite
proxies to the internal API origin; the browser never sees the internal
address). All money and sequence values cross the API as **JSON strings**
(T-049) — never as JSON numbers.

**Uniform error envelope (every non-2xx):**

```json
{ "error": { "code": "ACCOUNT_NOT_FOUND", "message": "Account not found." } }
```

**Session:** opaque HttpOnly cookie `bv_session`; the token is stored hashed and
is never readable from JavaScript. Roles, permissions and account ownership
are always re-derived from the database — never from the request.

## Endpoint matrix

| # | Endpoint | Role / permission | Request | Response | Idempotency | Transaction boundary | Ledger effect | Refusal behaviour | Tests |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `GET /health` | public | — | `{"ok":true}` | n/a (read) | none | none | always 200 while the process is up | `health.api.test.ts` |
| 2 | `GET /ready` | public | — | `{"ok":bool,"checks":{"postgres":"ok\|unavailable","redis":"ok\|unavailable"}}` | n/a (read) | none | none | 503 when a component is unavailable (Redis degradation is reported, never fatal — T-060) | `health.api.test.ts` |
| 3 | `POST /register` | public, IP rate-limited | `{email,password}` (strict — an unknown field such as `role` is refused) | `201 {user:{id,email,role}}` — role is server-fixed `ACCOUNT_HOLDER` | no key; duplicate email is refused | **Prisma interactive tx**: user row + `USER_REGISTERED` audit commit together | none | `400 VALIDATION_FAILED` (uniform for every invalid registration — REG-002); `429 RATE_LIMITED`; `500 INFRA_FAILURE` when the audit write fails (the user row is rolled back) | `register.api.test.ts` (REG-001/002), `auditAtomicity.api.test.ts` |
| 4 | `POST /login` | public, IP rate-limited | `{email,password}` | `200 {user:{id,email,role}}` + `Set-Cookie: bv_session=…` | no key; re-login issues a new session | **Prisma interactive tx**: session row + `LOGIN_SUCCEEDED` audit commit together | none | `401 UNAUTHENTICATED` — identical envelope for unknown user, wrong password and disabled account (AUTH-005); `429 RATE_LIMITED`; `500 INFRA_FAILURE` (the session row is rolled back) | `auth.api.test.ts` (AUTH-005/006), `auditAtomicity.api.test.ts` |
| 5 | `POST /logout` | any authenticated actor | — | `200 {ok:true}` + cookie cleared | idempotent by effect (revocation is a predicate) | **Prisma batch tx**: `sessions.revoked_at` + `SESSION_REVOKED` audit commit together | none | `401 UNAUTHENTICATED` without a session; `500 INFRA_FAILURE` when the audit write fails — the revocation is rolled back, the session stays valid and the client must not claim success | `auth.api.test.ts` (AUTH-006), `auditAtomicity.api.test.ts`, `apps/web/lib/logout.test.ts` |
| 6 | `GET /accounts` | authenticated; holders see only granted accounts, ADMIN/AUDITOR see all | — | `200 {accounts:[{id,account_number,label,currency_code,kind,status,balance_minor,event_last_seq}]}` | n/a (read) | none | none | `404 ACCOUNT_NOT_FOUND` for a holder without any visible account (uniform, no enumeration) | `money.api.test.ts`, `grantsAuth.test.ts` |
| 7 | `POST /accounts` | **ADMIN only** | `{accountNumber,label,currencyCode,kind,status?}` | `201 {account:{…}}` | no key; `accountNumber` is unique | Prisma (routine CRUD) + `accounts` insert | creates the row only (no money) | `404 ACCOUNT_NOT_FOUND` for any non-admin caller (uniform); `400 VALIDATION_FAILED` for an invalid body or a duplicate account number | `money.api.test.ts` (AC2.1) |
| 8 | `GET /accounts/:accountId` | authenticated + visible account | — | `200 {account:{…}}` | n/a (read) | none | none | `404 ACCOUNT_NOT_FOUND` for a non-existent, invisible or over-range id | `money.api.test.ts`, `int64Boundary.api.test.ts` |
| 9 | `GET /accounts/:accountId/statement` | authenticated + VIEW grant (or ADMIN/AUDITOR) | `?limit=&cursor=` | `200 {account,events[],attempts[],nextCursor}` | n/a (read) | none | none (read-only) | `404 ACCOUNT_NOT_FOUND` (unknown/invisible account); `400 VALIDATION_FAILED` for a malformed limit or cursor | `statements.api.test.ts` (STMT-001/002) |
| 10 | `POST /accounts/:accountId/deposits` | **ADMIN only** (H-2 cash desk) | `Idempotency-Key` header + `{amountMinor,currencyCode}` | `200 {status:"SUCCEEDED",journalTransactionId,replayed}` | **required** — scope `(actor, operation, key)`; a retry replays the stored result; the same key with a different payload → `409 KEY_REUSED` | **one raw-pg transaction** (raw pg owns all money paths — ADR-005): idempotency claim, balance check, journal, ledger entries, cached balance, attempt row | DEBIT `EXTERNAL_CLEARING` + CREDIT the customer account | `404` (not visible / not a customer account), `409 INSUFFICIENT_FUNDS\|ACCOUNT_NOT_ACTIVE\|CURRENCY_MISMATCH\|KEY_REUSED`, `429`, `503 LOCK_TIMEOUT` (retry-safe, key not consumed), `500 INFRA_FAILURE` | `money.api.test.ts` (IDEM-001/003), `phase12Adversarial.test.ts` (A1/A2) |
| 11 | `POST /accounts/:accountId/withdrawals` | ADMIN, or the holder with a WITHDRAW grant on the source | `Idempotency-Key` + `{amountMinor,currencyCode}` | `200 {status:"SUCCEEDED",journalTransactionId,replayed}` | as above | one raw-pg transaction | DEBIT the customer account + CREDIT `EXTERNAL_CLEARING` | as above, plus `409 INSUFFICIENT_FUNDS` (no overdraft — the balance is checked under the account lock) | `money.api.test.ts`, `ledgerCore.test.ts` (CON-001), `phase12Adversarial.test.ts` (A1) |
| 12 | `POST /transfers` | **TRANSFER grant on the source account** (every actor, including admins — AUTH-004) | `Idempotency-Key` + `{sourceAccountId,destinationAccountId,amountMinor,currencyCode}` | `200 {status:"SUCCEEDED",journalTransactionId,replayed}` | as above | one raw-pg transaction; both account rows are locked `FOR UPDATE` in ascending id order (deterministic order — no deadlock) | DEBIT the source + CREDIT the destination (both legs customer accounts; the clearing account is not touched) | `404 ACCOUNT_NOT_FOUND` (no grant / unknown / not visible — uniform), `409 INSUFFICIENT_FUNDS\|ACCOUNT_NOT_ACTIVE\|SYSTEM_ACCOUNT_NOT_ALLOWED\|SAME_ACCOUNT\|KEY_REUSED`, `429`, `503`, `500` | `money.api.test.ts`, `ledgerCore.test.ts` (CON-002/003/004), `phase12Adversarial.test.ts` (A2/A3) |
| 13 | `GET /transactions/:transactionId` | authenticated; ADMIN/AUDITOR see any, a holder only with a VIEW grant on an involved account | — | `200 {transaction:{…}}` | n/a (read) | none | none | `404 ACCOUNT_NOT_FOUND` for an unknown, invisible or over-range id | `money.api.test.ts`, `int64Boundary.api.test.ts` |
| 14 | `GET /audit/events` | **ADMIN or AUDITOR** | `?limit=&cursor=&event_type=&subject_type=&actor_id=&from=&to=` | `200 {events:[…],nextCursor}` | n/a (read) | none | none | `404 ACCOUNT_NOT_FOUND` for any other role (deny-by-default, no enumeration); `400 VALIDATION_FAILED` for a malformed cursor or an out-of-range `actor_id` | `audit.api.test.ts` (AUD-001/002) |
| 15 | `GET /reconciliation/summary` | **ADMIN or AUDITOR** | — | `200 {conservation:{customerBalancesTotal,clearingBalance,conserved},accounts:[…]}` | n/a (read) | none | none (read-only; both sides derived from `ledger_entries`) | `404` for any other role | `reconciliation.api.test.ts`, `reconciliationConservation.api.test.ts` |
| 16 | `GET /reconciliation/accounts/:accountId` | **ADMIN or AUDITOR** | — | `200 {account,storedBalance,derivedBalance,balanceReconciled,sequenceReconciled,reconciled}` | n/a (read) | none | none | `404` for any other role; `404` for an unknown or over-range account id | `reconciliation.api.test.ts`, `reconciliationConservation.api.test.ts` |
| 17 | `POST /users` | **ADMIN only** | `{email,password,role}` (`ADMIN\|ACCOUNT_HOLDER\|AUDITOR`) | `201 {user:{id,email,role}}` | no key; email unique | **Prisma interactive tx**: user row + `USER_CREATED` audit commit together | none | `404 ACCOUNT_NOT_FOUND` for a non-admin; `400 VALIDATION_FAILED` for an invalid body or a duplicate email; `500 INFRA_FAILURE` (the user row is rolled back) | `admin.api.test.ts`, `auditAtomicity.api.test.ts` |
| 18 | `PATCH /users/:userId/role` | **ADMIN only** | `{role}` | `200 {ok:true,userId,role}` | no key | one raw-pg transaction: `admin_control` row `FOR UPDATE` → target sessions → target user row, + `role_changed` audit | none | `409 LAST_ADMIN_PROTECTED` when it would leave zero active admins; `400 VALIDATION_FAILED` for a self-change; `404` for an unknown/over-range user; `500` on audit failure (everything rolls back) | `admin.api.test.ts` (ADMIN-001/002) |
| 19 | `POST /account-permissions` | **ADMIN only** | `{userId,accountId,permission}` (`VIEW\|DEPOSIT\|WITHDRAW\|TRANSFER\|ADJUST`) | `201 {ok:true,userId,accountId,permission}` | no key; an active identical grant → `400` | one raw-pg transaction: grant insert + `permission_granted` audit commit together | none | `409 SELF_GRANT_REFUSED` (an admin may never grant to themself — AUTH-004); `404 ACCOUNT_NOT_FOUND` for an unknown or over-range user/account (the target must exist — the database enforces it too); `400` for a duplicate grant | `admin.api.test.ts` (AUTH-004) |
| 20 | `DELETE /account-permissions` | **ADMIN only** | `{userId,accountId,permission}` | `200 {ok:true,userId,accountId,permission,revoked:bool}` | idempotent by effect; revoking an unknown grant is an audited no-op (`revoked:false`) | **Prisma interactive tx**: revocation + `permission_revoked` audit commit together | none | `404` for an unknown/over-range user; `409 SELF_GRANT_REFUSED`; `500` on audit failure — the grant stays active | `admin.api.test.ts`, `auditAtomicity.api.test.ts` |

## Cross-cutting rules

| Rule | Where it lives | Why |
|---|---|---|
| Uniform 404 instead of 403/401 for account-scoped refusals | `apps/api/src/http/errors.ts`, route handlers | no resource enumeration (AUTH-007/016) |
| Idempotency scope `(actor_id, operation, idempotency_key)` + DB unique constraint | `idempotency_records`, `transactionRunner.ts` | duplicate requests never move money twice (IDEM-001…006) |
| Business refusals do **not** consume the key; infrastructure failures do **not** consume it either (retry-safe) | `transactionRunner.ts` | a retry after a timeout can reuse the same key |
| Every money value is a decimal **string**; ids are validated against the signed 64-bit range before they reach the database | `domain/money.ts`, `isInt64Token` | no float rounding, no `22003` → 500 (T-049, T-023) |
| `57014` is retry-safe **only** for a statement timeout | `domain/transactionRunner.ts` | a user cancellation is an `INFRA_FAILURE`, not a false 503 (T-035 family) |
| The origin of a mutation must be acceptable (`APP_ORIGIN` allow-list in production) | `apps/api/src/http/origins.ts` | CSRF mitigation for the proxied deployment topology |
| Reconciliation is derived from `ledger_entries`, never from cached balances | `http/routes/reconciliation.ts` | SYSTEM accounts carry NULL cached balances (P6.2) |

## Error codes

`VALIDATION_FAILED` (400) · `INVALID_BODY` (400) · `UNAUTHENTICATED` (401) ·
`RATE_LIMITED` (429) · `ACCOUNT_NOT_FOUND` / `FORBIDDEN` (404) ·
`INVALID_AMOUNT`, `CURRENCY_MISMATCH`, `SAME_ACCOUNT`,
`SYSTEM_ACCOUNT_NOT_ALLOWED`, `INSUFFICIENT_FUNDS`, `KEY_MISMATCH`,
`KEY_REUSED`, `ACCOUNT_NOT_ACTIVE`, `LAST_ADMIN_PROTECTED`,
`NONZERO_BALANCE`, `SELF_GRANT_REFUSED` (409) · `LOCK_TIMEOUT` (503) ·
`INFRA_FAILURE` (500).

`503 LOCK_TIMEOUT` is **retry-safe**: the transaction rolled back, the
idempotency key was **not** consumed, and a retry with the same key is the
correct client behaviour.
