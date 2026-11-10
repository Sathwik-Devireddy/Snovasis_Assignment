# Architecture — Proposed Design to Validate

## Status

Proposed baseline only. The system architect must inspect the current repository and produce ADRs before implementation. Preserve an existing working stack unless a documented decision and human approval authorize a change.

**Phase 3 (2026-11-07):** the greenfield audit stood — no existing repository to preserve — and the ADR set is drafted from `docs/PROPOSED_DEFAULTS.md` D-1…D-13: `docs/adr/ADR-001`…`ADR-007` (stack/layering, ledger model, concurrency, idempotency+refusals incl. the failure-mode table, append-only/DB roles, authentication, revocation-vs-in-flight), plus the schema draft `docs/schema-draft.sql`. All are **Proposed**, awaiting Gate 3 human acceptance; no implementation begins before that approval. The per-operation sequences below (P3.8) name where each decision applies at runtime.

## Suggested topology

```text
Browser
  └── Next.js App Router UI (TypeScript)
        └── HTTPS REST API
              └── Fastify application services (TypeScript, see PROPOSED_DEFAULTS D-1/D-2)
                    └── PostgreSQL
```

A modular monolith is preferred for this time-boxed challenge. It is easier to test and explain than microservices and still allows clear module boundaries.

## Responsibilities

### Frontend

- Present data and collect user intent.
- Display server-calculated balances and transaction outcomes.
- Keep form state and the idempotency key stable for a single user-intended operation/retry.
- Provide confirmation, pending, success, refusal and retry-safe states.
- Never calculate authoritative balances or decide whether an operation is permitted.
- Use route protection for user experience, while relying on API authorization for actual security.

If Next.js is used, prefer server components by default and client components only for interactive controls. Use route groups such as `(auth)` and `(app)` only when they improve layout/organization. Root layout should own document-wide metadata, fonts, global CSS and providers that truly must be global. Auth and authenticated app layouts should own their respective shells. Avoid putting every page in one oversized client component.

### Backend

Suggested modules (names may adapt to the existing codebase):

- `auth`: identity, password verification, token/session validation.
- `authorization`: role and account/action permission checks.
- `accounts`: account lifecycle and balance read model.
- `ledger`: journal creation, posting validation and append-only access.
- `transfers`: transfer orchestration and idempotency.
- `statements`: per-account history and running balances.
- `audit`: refused attempts, actor attribution and review events.
- `health`: liveness/readiness without secret disclosure.

Business rules belong in application/domain services, not route handlers or UI components. Route handlers should validate transport input, authenticate, invoke services and serialize responses.

### Database

PostgreSQL is the transactional system of record. Use migrations for schema evolution. Financial mutations must run within a database transaction. The application DB role should have only the privileges needed; ledger runtime role should not have UPDATE/DELETE privileges on posting rows. Consider database triggers as defense in depth, while documenting the trust boundary of DB owners/superusers.

## Money and ledger design decisions to document

1. Use integer minor units (`BIGINT` or an equivalent safe integer representation) for amounts; no floating-point arithmetic.
2. Store currency explicitly. Do not silently mix currencies.
3. Use a journal transaction and multiple ledger entries. Internal transfer creates balanced sender/receiver postings in the same transaction.
4. External deposit/withdrawal should use a clearing/control account or another explicitly balanced external-flow model.
5. Define debit/credit sign convention and explain how it maps to account balance changes.
6. Balance snapshots may be stored for fast reads, but their update must be atomic with the ledger posting and tested against ledger-derived balances.
7. A cross-row journal-balance invariant cannot be guaranteed by a simple row CHECK alone. Enforce it in the posting service and, where practical, via a deferred constraint trigger or controlled database posting function.

## Concurrency strategy to evaluate

Preferred simple strategy: lock all involved account rows in deterministic account-ID order using PostgreSQL `SELECT ... FOR UPDATE`; read balance only after lock acquisition; validate and write balances and ledger postings in one transaction. (The money-command runner's *pre-lock semantic checks* run before any account-row lock — see `docs/PROPOSED_DEFAULTS.md` D-8 and `docs/REFUSAL_CODES.md` §2.) A conditional atomic UPDATE with a sufficient-balance predicate can also be valid if the complete transfer/journal operation is protected and verified. Document isolation level, deadlock behavior and retry policy.

Never lock sender then receiver in arbitrary order. Consistent lock order reduces deadlock risk. Do not catch a database error and continue using a failed transaction.

## Idempotency strategy to evaluate

- Scope a client key to actor and operation (or another explicit namespace).
- Store a canonical request payload hash and the final response/result reference.
- Enforce uniqueness in PostgreSQL.
- Same key + same hash: return the stored outcome **only after the replay re-evaluation gate passes** — session validity (revoked/expired session → `401 UNAUTHENTICATED`), grant/account visibility (revoked grant or lost visibility → the uniform `404 ACCOUNT_NOT_FOUND` envelope), and involved-account status (each still `ACTIVE`; a still-viewable suspended/closed account → `409 ACCOUNT_NOT_ACTIVE`), with the status re-read under a `FOR SHARE` account-row lock so a concurrent suspension/closure yields exactly two legal orders (`docs/PROPOSED_DEFAULTS.md` D-8 step 2, `docs/REFUSAL_CODES.md` §3).
- Same key + different hash: return a conflict; never reinterpret the key.
- Concurrent duplicate: rely on database uniqueness/transaction behavior so only one execution wins; test using separate DB connections.
- Decide and document whether validation refusals are persisted as replayable outcomes. The challenge requires refused attempts to be auditable. **Decided (D-9 / ADR-004):** business refusals are committed replayable outcomes inside the money transaction; authorisation refusals are written in a separate short audit transaction; never as postings.
- Define key retention/expiry; do not expire keys while a retry could reasonably duplicate a financial effect.

## Money-operation sequences (Phase 3, P3.8)

Canonical step-by-step walkthroughs of the three money operations, naming where authentication (authN), authorisation (authZ), the idempotency-key claim, the account locks, the balance checks, the writes and the commit happen. The full transaction flow, replay gate and the per-step failure-mode table ("process dies at each step") are normative in `docs/adr/ADR-004-idempotency-and-refusals.md`; refusal codes follow `docs/REFUSAL_CODES.md` §2's canonical order. Differences: only the remarked steps below; the shared prefix is common to all three.

**Shared (all three operations, one transaction each):**

1. *authN* — session row re-read `FOR SHARE` (first money-path lock; ADR-006/SESS-001). Invalid ⇒ 401; write nothing.
2. *authZ* — actor's `users` row + grant rows `FOR SHARE` (ascending id; ADR-007). Missing grant / invisible account ⇒ ROLLBACK, uniform 404, refusal attempt row written in a separate short audit transaction.
3. *key claim* — `INSERT idempotency_records … ON CONFLICT DO NOTHING`; conflict ⇒ hash compare → `409 KEY_REUSED` or the **replay gate** (session → grants/status; `401`/uniform-404/`409 ACCOUNT_NOT_ACTIVE`) → stored outcome `replayed: true` only on full pass (ADR-004).
4. *pre-lock checks* — `SAME_ACCOUNT`, `INVALID_AMOUNT` (`<=0`/cap), `CURRENCY_MISMATCH`, destination kind — decided without account-row locks or balance reads (commit a replayable refusal, NULL balance).
5. *lock* — involved **CUSTOMER** account rows `ORDER BY id FOR UPDATE` (SYSTEM rows never locked — ADR-002/ADR-003).
6. *under-lock checks* — status `ACTIVE` on all involved accounts (SUSPENDED blocks both directions), then sufficient funds (refusal commits with measured balance + allocated `account_event_seq`).
7. *write* — journal + entries (each event bumps `accounts.event_last_seq`), balances updated.
8. *response + commit* — store the string-serialised response body on the key row; COMMIT; return.

**Deposit (`POST /accounts/{id}/deposits`, ADMIN role-level authority — H-2):** shared 1–3 — authZ additionally confirms the actor is ADMIN (role-level, no per-account grant required); pre-lock destination-kind check refuses a SYSTEM destination (T-043: externally uniform-404, internally `SYSTEM_ACCOUNT_NOT_ALLOWED`); lock = destination only.

**Withdrawal (`POST /accounts/{id}/withdrawals`, ADMIN role-level **or** holder `WITHDRAW` grant):** shared 1–3 (`DEPOSIT`-style grant never confers withdrawal); lock = source only; under-lock sufficient-funds check on the source balance.

**Transfer (`POST /transfers`, actor holds `TRANSFER` on the source):** shared 1–2 with grants read for *both* source and destination accounts (visibility of the destination is what preserves the uniform-404 rule); pre-lock `SAME_ACCOUNT`; lock = source + destination ascending id (deadlock-free, CON-003); under-lock checks on both statuses and the source balance.

**Always:** no path executes financial logic twice per key; replays re-run the gate only (no writes, no counter bump — ADR-004 §4: the guarantee covers the gate pass and post-claim refusals; a replay refused at the pre-claim authorisation step records the ordinary D-9 authorisation-refusal row); refusals are recorded per D-9's two paths.

## Frontend organization candidate (Next.js only)

```text
src/
  app/
    (auth)/login/page.tsx
    (app)/layout.tsx
    (app)/dashboard/page.tsx
    (app)/accounts/page.tsx
    (app)/accounts/[accountId]/page.tsx
    (app)/transfers/page.tsx
    (app)/statements/page.tsx
    (app)/admin/page.tsx
    (app)/auditor/page.tsx
    layout.tsx
  components/
    ui/                 # primitives: button, input, dialog, table
    layout/             # app shell, navigation, page header
    accounts/
    transfers/
    statements/
  features/              # feature-level hooks, schemas and API adapters
  lib/                   # API client, auth helpers, formatters
  styles/
```

Do not force this exact tree onto an existing repository. Avoid mixing server-only secrets or database clients into browser bundles. Keep reusable primitives separate from domain-specific feature components. Avoid duplicating domain rules between frontend and backend.

## Observability and operational safety

- Structured logs with request/transaction correlation IDs.
- Never log credentials or full authorization headers.
- Log idempotency key hashes or safe identifiers, not secrets.
- Health endpoint reveals availability only, not environment variables or database credentials.
- Use HTTPS and host-managed secrets.
- Seed only synthetic demo data.

## BalanceVault expansion — data access, rate limiting, onboarding (2026-11-09, additive)

The challenge organizer ran the project as **BalanceVault** (renamed + expanded LedgerLine). All original LedgerLine financial-integrity architecture is unchanged and mandatory. The expansion adds two infrastructure components and two application capabilities, placed as follows:

1. **Prisma Client (routine typed access)** — sits in `infrastructure` alongside the raw-`pg` client, behind the same application-layer use-case interfaces. It is the default client for non-financial CRUD (users, sessions, account/grant administration, audit-event recording, statement/audit pagination). The financial path (D-8 in `docs/PROPOSED_DEFAULTS.md`; ADR-004/ADR-005) is **never** implemented through Prisma: single-transaction-owner rule, lock order, grant model and append-only enforcement are unchanged (`ADR-005` §"Data-access transaction strategy"). Migration authority remains node-pg-migrate; Prisma's schema mirrors it and its migration engine is not used.
2. **Redis (API rate limiting only)** — an edge/HTTP-layer limiter (per actor identity + route class; applied at login, registration and money endpoints). Rate limiting is an availability control, not a financial control: Redis holds neither balances, ledger, idempotency nor authority data, and a Redis outage can only affect limiting (fail-soft) — the audit-table flood countermeasure inside the database (T-042's `transaction_attempts` rate) is the second line and does not depend on Redis. Idempotency remains PostgreSQL-unique-constraint based; no Redis-lock idempotency is permitted.
3. **User onboarding and registration** — self-service registration creates a user with the `ACCOUNT_HOLDER` role **and no accounts, grants or money authority** (deny-by-default per `docs/AUTHZ_MATRIX.md`); account provisioning and grants remain admin-only. Credentials, session and hashing rules of ADR-006 (`argon2id`, opaque hashed session tokens, `HttpOnly; Secure; SameSite=Lax`) apply unchanged. Registration traffic is rate limited (above) and test-plan rows REG-001/REG-002 assert authority boundaries.
4. **First-admin bootstrap script** — the executable host command already specified in `AUTHZ_MATRIX.md` §C.1.3 becomes an implementation deliverable at Phase 5 (P5.9): `bootstrap` creates the first ADMIN from a host-environment-supplied secret, refuses re-run once an admin exists, emits the `bootstrap_created` audit event, and (with `rotate-admin-credentials`) covers credential recovery — still never reachable through the API.
5. **Health, production verification** — `/health` (liveness) stays credential-free; `/ready` checks PostgreSQL and Redis reachability (and, after P4.3, migration-prefix state). Production database-role verification (PRODROLE-001, including the Prisma-under-`ledgerline_app` equivalence assertion) is added to the pre-deployment checklist (H-4 window).

**Materially affected documents (each carrying its own dated note):** `ADR-001` (stack note + trade-off rescoping), `ADR-005` (transaction strategy — normative), `phases/PHASE-04-foundation-deploy.md` and `phases/PHASE-05-identity-authorization.md` (additive tasks, original order preserved), `docs/ACCEPTANCE.md` + `docs/TEST_PLAN.md` (new IDs RATE-001/002, REG-001/002, BOOT-001/002, PRODROLE-001, HEALTH-001/002, DEPLOY-001, PRISMA-001, TX-BOUNDARY-001), `THREATS.md` (T-060/T-061/T-062), `docs/API_CONTRACT.md`. Status lines, Gate states and all previously approved decisions are unchanged; human approval items are listed in the current readiness report.
