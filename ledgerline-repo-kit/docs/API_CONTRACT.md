# API Contract — Proposed Endpoint Inventory

This is a proposed contract, not evidence that endpoints already exist. Match route naming to the actual repository and document any deviations. Every endpoint must state authentication, authorization and financial side effects.

## Conventions

- HTTPS only in production.
- JSON request/response bodies.
- Amounts are integer minor units (`amount_minor`), never decimal floats.
- **Money-field precision (`REFUSAL_CODES.md` §2):** in requests, every money field must be a **raw integer JSON token** (grammar `-?(0|[1-9][0-9]*)`; no decimals, exponents, `+` or string/whitespace variants → otherwise `400 VALIDATION_FAILED`); tokens beyond the signed 64-bit BIGINT range are also `400 VALIDATION_FAILED`. In responses, every money/sequence integer is serialised as a **JSON string** so no client parser can lose precision (T-049, AMT-001).
- **Target-visibility rule (`REFUSAL_CODES.md` §3):** an error about a target account the caller **cannot view** returns the single uniform `404 ACCOUNT_NOT_FOUND` envelope — regardless of whether the account is nonexistent, grant-forbidden, closed, suspended, or of kind SYSTEM. The response discloses neither existence, status (`account_status_detail` is never shown to such callers) nor account kind. Granular `409` target codes are returned **only** to account-visible callers (e.g. ADMIN cash-desk operations).
- Use stable error codes and appropriate HTTP statuses.
- Every money-moving request requires an `Idempotency-Key` header.
- Same key + same canonical payload replays the stored outcome — **only after the replay re-evaluation gate passes** (revoked/expired session → `401 UNAUTHENTICATED`, never a 404 for a revocation; revoked grant / lost visibility → the uniform `404 ACCOUNT_NOT_FOUND` envelope; still-visible non-`ACTIVE` account → `409 ACCOUNT_NOT_ACTIVE` — `docs/IDEMPOTENCY_BEHAVIORS.md` row 7); same key + different payload → `409 KEY_REUSED`.
- Every account-specific action checks account permission on the server.
- Never trust `user_id`, role, balance or permission sent by the browser.

## Authentication

| Method/path | Who | Purpose | Money effect |
|---|---|---|---|
| `POST /api/v1/auth/login` | Public | Authenticate user | None |
| `POST /api/v1/auth/logout` | Authenticated | End/revoke session where supported | None |
| `GET /api/v1/me` | Authenticated | Current identity, role and safe profile | None |

## Accounts and permissions

| Method/path | Who | Purpose | Money effect |
|---|---|---|---|
| `POST /api/v1/accounts` | Admin | Create account | None; opening funds must be a separate posted deposit |
| `GET /api/v1/accounts` | Admin or account holder with access | List only permitted accounts | None |
| `GET /api/v1/accounts/{accountId}` | User with VIEW permission | Account details and server balance | None |
| `GET /api/v1/accounts/{accountId}/permissions` | Admin / permitted auditor | Inspect permissions | None |
| `PUT /api/v1/accounts/{accountId}/permissions` | Admin | Grant/revoke scoped permissions | None; audit the change |

## Money movement

| Method/path | Who | Purpose | Money effect |
|---|---|---|---|
| `POST /api/v1/accounts/{accountId}/deposits` | **Admin only (decision H-2 — admins have role-level deposit authority; holders are never granted `DEPOSIT` in v1, see `AUTHZ_MATRIX.md` §A/§B)** | External deposit — a cash-desk operation, distinct from internal ledger postings (transfers) and from the deferred ADJUSTMENT journal (H-5) | Increases customer balance and posts balancing clearing entry atomically; destination must be an **active CUSTOMER** account — a SYSTEM destination is refused internally and folded into the target-visibility envelope for non-account-visible callers |
| `POST /api/v1/accounts/{accountId}/withdrawals` | Admin (role-level) **or** account holder with the `WITHDRAW` grant on the account (`AUTHZ_MATRIX.md` §A) | External withdrawal | Decreases customer balance if sufficient funds; source must be an **active CUSTOMER** account; posts balancing clearing entry atomically |
| `POST /api/v1/transfers` | Actor with TRANSFER permission on source; destination policy also checked | Internal transfer | Debit source + credit destination in one transaction; net customer movement zero |
| `GET /api/v1/transactions/{transactionId}` | Actor with access to relevant account(s), admin or auditor per policy | Inspect result | None |

All three money-moving operations require an idempotency key. **Same key + same canonical payload returns the original result (`replayed: true` modifier on the envelope) — but only after the replay re-evaluation gate passes** (`docs/IDEMPOTENCY_BEHAVIORS.md` row 7): session validity first (a revoked/expired session → `401 UNAUTHENTICATED`), then grant/account visibility (revoked grant or lost visibility → the uniform `404 ACCOUNT_NOT_FOUND` envelope), then the involved accounts' status (`ACTIVE` required, checked under a `FOR SHARE` read that serialises with concurrent suspension/closure; a still-viewable suspended/closed account → `409 ACCOUNT_NOT_ACTIVE`). This is also true for a concurrent in-flight duplicate — the loser passes the same gate after the winner commits and then replays the stored outcome, or receives the gate's refusal (see `docs/IDEMPOTENCY_BEHAVIORS.md` rows 4–7). Same key + different payload returns the canonical conflict `409 KEY_REUSED` (decided from the key row alone, before the gate). A previously refused attempt replays the same refusal — likewise only via the gate. A replay refused by the **authorisation stage** is refused before the key row is consulted and returns the uniform `404 ACCOUNT_NOT_FOUND` envelope; its refusal is audited server-side — one D-9 insert attempted per refused call, exactly one durable audit row when persistence succeeds, T-042-bounded (a failed insert is logged and the refusal still returns) — and `KEY_REUSED` sits **below** authorisation in the enforced order: a now-unauthorised caller never receives `409 KEY_REUSED` for a key they can no longer honour. The API must document response behavior for an in-flight duplicate and a previously refused attempt. **Replay is semantic** (ADR-004 §1a): the replayed envelope carries the stored status and stored business values; byte-level JSON equality is not promised (`response_body` is JSONB — key order/whitespace/number formatting normalise); the financial fields keep the T-049 string serialisation. Concurrency of same-key requests is serialised by the PostgreSQL unique constraint on `(actor_id, operation, idempotency_key)` — there is no PROCESSING state and no second claim mechanism.

## Statements and audit

| Method/path | Who | Purpose | Money effect |
|---|---|---|---|
| `GET /api/v1/accounts/{accountId}/statement` | User with VIEW permission; auditor within scope | Paginated postings, refused attempts and running balance | None |
| `GET /api/v1/audit/events` | Auditor/admin per policy | Read audit records | None |
| `GET /api/v1/reconciliation/accounts/{accountId}` | Admin/auditor per policy | Compare stored balance to ledger-derived total | None |

## Suggested error taxonomy (aligned with `docs/REFUSAL_CODES.md` Rev 4 — external face)

**Internal/external split:** what follows is the **externally visible** response face (`REFUSAL_CODES.md` §0, two-sided truth). Internal attempt/audit rows record the exact reason code (e.g. internal `FORBIDDEN` vs `ACCOUNT_NOT_FOUND`, `SUSPENDED` vs `CLOSED` in `account_status_detail`); that detail is visible only to admin/auditor audit views per `REFUSAL_CODES.md` §6, never in the external envelope.

**Uniform envelope:** a `404 ACCOUNT_NOT_FOUND` response for a target the caller cannot view has identical HTTP status, body shape, message and code across every hidden cause — nonexistent, grant-forbidden (internal `FORBIDDEN`), closed (internal `ACCOUNT_NOT_ACTIVE`/`CLOSED`), suspended (internal `ACCOUNT_NOT_ACTIVE`/`SUSPENDED`), or SYSTEM kind (internal `SYSTEM_ACCOUNT_NOT_ALLOWED`). Response latency is **not promised identical**: it is mitigated (single code path, no case-dependent DB round-trip shortcut) and verified by the statistical test TIMING-001 (`docs/TEST_PLAN.md`, `timing.api.test.ts` — **best-effort and non-blocking; not a required CI pass criterion**) — an absolute equal-latency claim is deliberately not made (T-020).

- `400 VALIDATION_FAILED` — malformed input only (shape errors, including non-integer, non-grammar or beyond-64-bit `amount_minor` tokens — see `REFUSAL_CODES.md` §2; no attempt row).
- `401 UNAUTHENTICATED` — no valid identity (missing/expired/revoked session).
- `404 ACCOUNT_NOT_FOUND` — the **single uniform envelope** for errors about a target account the caller cannot view (see the target-visibility rule above; internal attempt rows keep the true reason).
- `409 INSUFFICIENT_FUNDS` — sufficient-funds refusal on the source account (the caller always holds that account's grant, so the detail is entitled), recorded as a committed attempt with the measured balance (`REFUSAL_CODES.md` §4).
- `409 ACCOUNT_NOT_ACTIVE` — the **source** account is not `ACTIVE` (internal `account_status_detail` records `SUSPENDED`/`CLOSED`, but that detail is audit-view content only, never in the external body). For a **destination** account this code is returned only to account-visible callers; non-account-visible callers receive the uniform 404 envelope above.
- `409 SAME_ACCOUNT` — transfer source equals destination (pre-lock; recorded attempt, no balance).
- `409 INVALID_AMOUNT` / `409 CURRENCY_MISMATCH` — business refusals on a well-formed request (pre-lock; recorded attempts, no balance; `REFUSAL_CODES.md` §2/§4).
- `409 SYSTEM_ACCOUNT_NOT_ALLOWED` — the target is a SYSTEM (clearing/adjustment) account; returned **only** to account-visible callers (e.g. the ADMIN cash desk); all other callers receive the uniform 404 envelope above.
- `409 KEY_REUSED` — the **canonical idempotency conflict code** (`docs/IDEMPOTENCY_BEHAVIORS.md` row 5), used for: same scoped key with a different canonical payload. It is the *only* conflict code used by the API — a concurrent same-key duplicate is **not** a conflict: the loser passes the row-7 replay re-evaluation gate and then replays the stored outcome, or receives the gate's refusal (row 6).
- `409 LAST_ADMIN_PROTECTED` — administration change that would leave zero active administrators (`AUTHZ_MATRIX.md` §C.2; audit event, not an attempt row).
- `409 NONZERO_BALANCE` — account close refused while the balance is non-zero (`AUTHZ_MATRIX.md` §F; drain via permitted money operations first, or a documented corrective posting after Gate 9; audit event, not an attempt row).
- `429 RATE_LIMITED` — rate limit exceeded (login flood and forbidden-call flood, including the attempt-write flood cap, T-042).
- `503 LOCK_TIMEOUT` — lock/statement timeout; **retry-safe with the same idempotency key** (key not consumed); best-effort FAILED audit row, never part of statements.
- `500 INFRA_FAILURE` — unexpected infrastructure failure (name aligned to the closed code list in `REFUSAL_CODES.md` §3; detailed stack trace stays server-side; best-effort FAILED audit row, key not consumed, retry safe).

## Documentation requirement

For each implemented endpoint, add: role(s), account permission(s), request schema, response schema, idempotency requirement, transaction boundary, ledger effect, refusal behavior and relevant test IDs.

## BalanceVault expansion — additive endpoints and semantics (2026-11-09)

The organizer clarified BalanceVault as the renamed, expanded LedgerLine challenge. The additions below extend the HTTP surface; **every money-movement contract above is unchanged** — same envelopes, idempotency headers, lock/transaction guarantees and refusal codes. The original sections remain authoritative.

### `POST /register` (public, rate-limited)

- Purpose: self-service onboarding. Creates exactly one user; the role is **server-set to `ACCOUNT_HOLDER`** — a supplied `role` field is ignored/rejected, never honoured (T-061).
- Request: email, password (strength-checked), optional display name. No roles, grants, accounts or keys in the request.
- Effect: user row with `ACCOUNT_HOLDER`; **no accounts, no grants, no money authority** (deny-by-default, `AUTHZ_MATRIX.md`). No audit attempt row; an authentication-domain audit event where the audit design requires one.
- Responses: success envelope (201 with the account-creation pointers for admins only in admin surfaces — registration itself creates **no** account and the registrant has nothing to see); duplicate email → the canonical uniform error with **no user-existence disclosure** beyond the canonical shape (AUTH-005 pattern); validation failures → `400 VALIDATION_FAILED`; over-limit → `429 RATE_LIMITED`.
- Credentials: argon2id storage, opaque hashed session tokens, cookie flags per ADR-006 (`HttpOnly; Secure; SameSite=Lax`). Money-path identity rules are unchanged.
- Test IDs: REG-001, REG-002.

### Rate limiting (Redis) — `429` semantics

- Scope: register, login, and money endpoints (per-actor where a session is resolved, IP-based pre-auth). Configuration via env; no limits hard-coded at call sites.
- `429 RATE_LIMITED` (already in the taxonomy above) is returned with **zero side effect**: no attempt row, no balance change, **idempotency key not consumed** — a limited money request remains retry-safe with the same key.
- Degraded mode (T-060): with Redis unavailable the limiter fails **soft** — requests pass, `/ready` reports degraded; the DB-side T-042 attempt-write cap is the second line and does not depend on Redis. Redis is never an authority for money, ledger, idempotency or audit state.
- Test IDs: RATE-001, RATE-002.

### `/ready` expansion (liveness unchanged)

- `/health`: liveness only, credential-free — unchanged.
- `/ready`: PostgreSQL reachability **and** Redis reachability (plus the migration-prefix/D-6 state item after P4.3). On any component failure `/ready` responds negatively without disclosing credentials or environment details.
- Test ID: HEALTH-001.

### First-admin bootstrap script (host command, not an endpoint)

- Executable host command per `AUTHZ_MATRIX.md` §C.1.3: creates the first ADMIN from a host-env secret; emits `bootstrap_created`; **refuses re-run once an administrator exists** (approved decision 12); **never reachable through the HTTP API** — it is documented here for completeness of the operational surface only.
- Test IDs: BOOT-001, BOOT-002.

### Deployment readiness

- DEPLOY-001 (checklist at the P4.8 window): documented deploy commands for API + PostgreSQL + Redis; secrets from host env only; external `/health` check; **PRODROLE-001** — production role `ledgerline_app` works for both raw-`pg` and Prisma connections before deployment.

### Unchanged-by-declaration

- All money movement, statements, audit, account-administration and idempotency contracts above: unchanged. No financial operation runs through Prisma; financial operations are single raw-`pg` transactions (`ADR-005` §"Data-access transaction strategy"; TX-BOUNDARY-001). Migration authority remains node-pg-migrate (PRISMA-001 guards drift).
