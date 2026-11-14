# Security Review — Phase 3 final code-level review

*Date: 2026-11-14 · Baseline: `main` @ `66f2b29` · Reviewer: Phase 3 engineering agent (AI-assisted, human-owned)*

Scope: a code-level review of the existing implementation (no rebuild). Every area
from the Phase 3 security checklist was inspected by reading the actual source.
Only genuine defects are fixed; findings that are deliberate design choices or
owner decisions are classified and recorded here instead of changed unilaterally.

## Method

Full reads of the security-relevant surfaces at the Phase 3 baseline commit:

- **Auth/session:** `apps/api/src/auth/session.ts`, `apps/api/src/infrastructure/argon2.ts`, `apps/api/src/http/routes/auth.ts`
- **Authorization:** `apps/api/src/http/routes/admin.ts`, `accounts.ts`, `statements.ts`, `reconciliation.ts`, `audit.ts`, `money.ts`, `transactions/transactionRunner.ts` (role/grant checks in-transaction)
- **Guards/limits:** `apps/api/src/http/guards.ts`, `origins.ts`, `apps/api/src/infrastructure/rateLimiter.ts`, `config.ts`
- **Database roles/migrations:** `db/migrations/0001_roles.js` … `0006_account_permission_account_fk.js`, `apps/api/scripts/migrate.mjs`
- **Operational surface:** `apps/api/src/http/app.ts`, `server.ts`, `routes/health.ts`, `routes/ready.ts`
- **Frontend:** `apps/web/lib/api.ts`, `logout.ts`, `money-intent.ts`, `use-money-operation.ts`, `next.config.ts`
- **Registration:** `apps/api/src/http/routes/register.ts`

Findings below carry a severity, an evidence location, and a disposition.

## Findings summary

| # | Severity | Finding | Disposition |
|---|---|---|---|
| S-1 | **MEDIUM** | Login/register rate-limit buckets are IP-keyed while the API runs with `trustProxy: false` behind Render's router — all production clients share one bucket per identity | Documented; **owner decision** required (options below). Not changed unilaterally. |
| S-2 | LOW | No security-header layer (helmet or manual) on the API | Accept as-is with rationale (API is not browser-facing); recommendation recorded. |
| S-3 | LOW | `postcss` advisories via `next@15.5.29` (build-time only) | Already tracked as **T-063 OPEN**; no non-breaking fix exists; owner decision. |
| S-4 | LOW | T-042 attempt-write cap is best-effort (count + insert not serialised) | Already disclosed in `THREATS.md`; no change (the cap must not add lock contention on the failure path). |
| S-5 | INFORMATIONAL | `LOGIN_FAILED` audit row is best-effort; uniform 401 is always preserved | By design (AUTH-005); no change. |
| S-6 | INFORMATIONAL | Money commands write `transaction_attempts` (D-9), not `audit_events` | By design per `AUDIT_COVERAGE.md`; refusal evidence lives in the durable attempt rows and is surfaced through statements/audit views. |
| S-7 | INFORMATIONAL | `ACCOUNT_CREATED`-family audit events (e.g. `USER_CREATED`, `USER_REGISTERED`) have no single direct test assertion dedicated to them; they are covered transitively by the audit-atomicity tests | Noted; no coverage gap that masks a defect. |
| S-8 | INFORMATIONAL | Statements expose the initiator's display name (derived from email) to *entitled* viewers only | By design (P10.2 visibility); holders only ever see initiators of events on accounts they can view. |

**CRITICAL: none. HIGH: none.** One MEDIUM finding (S-1) requires an explicit
owner decision; it is a deployment-topology concern, not an application defect.

## Verified strengths (evidence, not claims)

### Authentication
- **Password hashing:** argon2id at the OWASP 2023 baseline (m=19456, t=2, p=1) — `argon2.ts`. Registration verifies the produced hash is a real argon2id string before use (`register.ts:54`); admin user creation checks the `$argon2id$` prefix (`admin.ts:74`).
- **Timing-equalisation:** unknown email / disabled account still pay a full argon2 verification against a **real, never-matching DUMMY_HASH** (`auth.ts:62-68, 183-187`) — defeats the known-vs-unknown-account timing oracle.
- **Uniform refusals:** unknown user, bad password and malformed body all return the identical `401 UNAUTHENTICATED` envelope (`auth.ts:32, 48-53, 92`); registration failures are all the identical `400 VALIDATION_FAILED "Registration failed."` including the unique-violation path (`register.ts:43-49, 90-94`) — no account enumeration.
- **Session tokens:** opaque 256-bit random tokens; only their SHA-256 hash is stored (`sessions.token_hash`); the raw token is never persisted or logged. The active predicate is `revoked_at IS NULL AND expires_at > now()` and the actor (including status) is **re-derived from the database on every request** — nothing is trusted from the client (`session.ts`).
- **Cookie attributes:** `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` comes from the config-checked `cookieSecure` flag (`session.ts`). `config.ts` **refuses to boot in production** unless `COOKIE_SECURE=true`; verified live in production (`COOKIE_SECURE=true` in the deployed environment — boot succeeded and the fail-fast rule enforces it).
- **Session/audit atomicity:** session create + `LOGIN_SUCCEEDED` commit together (`auth.ts:102-116`); logout revocation + `SESSION_REVOKED` commit together (`auth.ts:162-176`); role change revokes all target sessions in the same transaction as the role update (`admin.ts:155-158`).

### Authorization
- **Server-side, deny-by-default:** every protected route resolves the actor server-side; non-admin calls to admin routes and holder calls to reconciliation/audit get the **uniform 404 envelope** — no existence leak (two-sided truth, AUTHZ_MATRIX §0).
- **Role changes:** ADMIN-only; self-role-change refused; **last-admin guard** under `admin_control FOR UPDATE` + count-under-lock so two concurrent demotions of different admins cannot leave zero admins (`admin.ts:127-150`).
- **Grants:** ADMIN-only; **self-grant refused** (`SELF_GRANT_REFUSED`, `admin.ts:202-204`); duplicate active grant refused; grant/revocation and their audit events commit in the same transaction (`admin.ts:217-244, 289-309`). Malformed/over-range ids get the same uniform 404 as nonexistent targets (no bigint-cast 500s, `admin.ts:196-198`).
- **Account visibility:** holders see only accounts with an active `VIEW` grant, enforced inside the SQL via parameterised `EXISTS` (`accounts.ts` L68-167 region); statements, transaction detail and reconciliation repeat the same rule per endpoint (`statements.ts:108-121`, `money.ts:271-282`, `reconciliation.ts:55-61`).
- **Registration authority floor:** role is the server-side constant `ACCOUNT_HOLDER`; the strict schema makes every escalation attempt an invalid body; registration never creates accounts or grants (`register.ts:24-29, 71`).
- **Money path authorization is in-transaction:** role/grant checks are re-read `FOR SHARE` inside the money transaction (session → users → grants → idempotency → accounts ascending-id lock order), so a concurrent revocation or role change linearises correctly (ADR-003/004/007; tests IDEM-006, REPLAY-AUTHZ-001).

### Database
- **Least privilege:** runtime role `ledgerline_app` has DML-only grants on application tables — **no UPDATE/DELETE on ledger, journal, audit or attempt rows** (migrations 0002/0003/0005). Append-only is enforced by row-level + TRUNCATE triggers that fire for **every** session including `ledgerline_owner`; the only bypass is a deliberate `ALTER TABLE … DISABLE TRIGGER` (ADR-005 residual, disclosed).
- **Migration ownership:** `ledgerline_owner` owns DDL; the bootstrap superuser runs only migration 0001 (role creation) — `migrate.mjs` guard prevents the whole set being applied as bootstrap. Bootstrap is disabled once an administrator exists (T-050 accepted residual on operator identity).
- **SQL parameterization:** every query in every route and domain module uses parameterised statements ($1… placeholders, typed casts); **no string interpolation of user input into SQL was found anywhere** in the reviewed surface. Cursor tokens, ids and amounts are validated (int64-token grammar, cursor schema checks) before reaching PostgreSQL, so over-range tokens get uniform 4xx instead of 22003 500s.
- **Transaction boundaries:** one raw-`pg` transaction per financial operation (TX-BOUNDARY-001); audit/state atomicity enforced via `prisma.$transaction` or explicit `BEGIN/COMMIT` pairs with rollback in `catch` and `release()` in `finally` on every hand-rolled client.

### API security
- **Request validation:** strict zod schemas (`.strict()`) on all bodies; `Idempotency-Key` header required (1–64 chars) for money movements; limit clamped 1–200 on paginated reads; body limit 64 KiB (`app.ts`).
- **CSRF mitigation:** mutation routes require `Content-Type: application/json` and an acceptable `Origin` — explicit `APP_ORIGIN` allow-list (required in production, fail-fast at boot), same-host allowance, and `x-forwarded-host` honoured **only** when no allow-list is configured (dev/test) (`guards.ts`, `origins.ts`). Non-browser, no-`Origin` server-to-server calls (the seed script) are allowed by design; the session cookie + SameSite policy remain the real defences.
- **Rate limiting:** Redis fixed-window, identity keys hashed, **fail-soft** on Redis outage (T-060) so a cache failure never blocks money movement; the DB-side T-042 attempt cap is the durable backstop.
- **Error handling:** single error mapper producing the uniform `{ error: { code, message } }` envelope; internal reason codes (e.g. `account_status_detail`, granular 409 target codes) never reach non-entitled callers (REFUSAL_CODES §4/§5).
- **Logging:** pino redacts password/token/cookie headers (LOG-001); no secrets in responses — `/me` carries id/email/role only.
- **/health vs /ready:** `/health` is a liveness check (`{ok:true}`); `/ready` actually checks PostgreSQL and Redis and returns 503 with the failing check named (`health.ts`, `ready.ts`; tested). Verified live in production this phase (see `PHASE_3_FINAL_REPORT.md` §Deployment).

### Frontend
- **Session handling:** the HttpOnly session cookie is never touched from JavaScript (`logout.ts:13`); logout redirects **only** after a confirmed 2xx (or a 401 meaning the session is already gone) — a network failure or 5xx shows a retry state instead of falsely claiming sign-out (`logout.ts:18-23`).
- **Money retries:** the retry re-sends the **original** idempotency key and payload (`money-intent.ts`); the error classifier (`api.ts:107-178`) maps 503 LOCK_TIMEOUT / 408 / network / 5xx to "outcome not known — retry with the SAME key" and never presents an unknown outcome as a confirmed refusal.
- **No tokens in browser storage:** authentication lives solely in the HttpOnly cookie; no session material is written to localStorage/sessionStorage.
- **Proxy:** `/api/:path*` rewrites to `API_INTERNAL_URL` (server-side env, never `NEXT_PUBLIC_*`); unset in production fails the build/start fast instead of proxying to `localhost` (`next.config.ts`).
- **Protected routes:** the root redirects unauthenticated visitors to `/login` (verified live: `307` on `/`, `200` on `/login`, `401` uniform envelope on `/api/me` through the Vercel→Render proxy).

## S-1 detail — shared rate-limit buckets behind Render (MEDIUM)

**Mechanism.** `rateLimiter.ts` keys buckets on the client IP (hashed). The API
runs with `trustProxy: false` (correct for trusting Render's edge, which does
not forward a per-client `X-Forwarded-For` chain that we can safely consume),
so behind Render's router **every client appears as one IP**. The strict
anti-brute-force intent of the login limiter is therefore blunted: an attacker
broadens the denial-of-service surface for legitimate logins, while a per-IP
*lockout* intent becomes a shared-bucket throttle.

**Impact.** Availability concern (a hostile client can exhaust the shared
login/register buckets), not a confidentiality/integrity concern. Financial
integrity is unaffected: the durable T-042 attempt cap and the money-path
locks are the real controls.

**Options (owner decision, deliberately not applied):**
1. Keep as-is — accept the shared bucket; simplest, and the strict limiter
   stays maximally strict.
2. Consume Render's forwarded header behind an allow-listed hop count
   (`trustProxy` with an explicit address) so buckets key on the real client.
3. Key the limiter on `(IP, submitted email)` so one hostile IP cannot lock out
   everyone, while a targeted brute-force on one identity still trips its own
   bucket.

## Recommendation

No code change is recommended by this review. The implementation's security
posture matches its documentation (AUTHZ_MATRIX, REFUSAL_CODES, THREATS,
AUDIT_COVERAGE). The single MEDIUM finding is a deployment-topology decision
for the owner; the LOW findings are already tracked in `THREATS.md` with owner
decisions recorded.
