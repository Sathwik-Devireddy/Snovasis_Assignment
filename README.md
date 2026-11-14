# BalanceVault

BalanceVault is a full-stack banking ledger application built around reliable, auditable money movement. It supports account management, deposits, withdrawals, transfers, statements, role-based access, and reconciliation while protecting financial integrity with integer minor units, balanced double-entry journals, database transactions, concurrency control, and idempotent requests.

> This project is also referred to as **LedgerLine** in architecture and implementation documentation. The application is a modular monolith with separate web and API workspaces.

## Table of contents

- [Features](#features)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Financial model and algorithms](#financial-model-and-algorithms)
- [Roles and permissions](#roles-and-permissions)
- [API functionality](#api-functionality)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Demo users and data](#demo-users-and-data)
- [Environment configuration](#environment-configuration)
- [Testing and quality checks](#testing-and-quality-checks)
- [Deployment](#deployment)
- [Detailed documentation](#detailed-documentation)

## Features

- **Double-entry financial ledger:** deposits, withdrawals, and transfers are represented by journal transactions with matching debit and credit entries.
- **Safe money representation:** amounts are integer minor units (paise) represented as `BigInt` in the API and decimal strings in JSON; floating-point arithmetic is not used.
- **Atomic money movement:** each financial operation writes its journal, entries, cached customer balances, idempotency result, and applicable attempt record within a PostgreSQL transaction.
- **Concurrency and overdraft protection:** account rows are locked before checking balances and writing postings; customer accounts cannot be overdrawn.
- **Retry-safe idempotency:** an actor, operation, and client-supplied idempotency key identify an operation. Repeating the same request does not post money twice.
- **Authentication and authorization:** registration, login, logout, opaque server-side sessions, global roles, and per-account permission grants.
- **Account and transaction views:** account listing/details, transaction lookup, and paginated account statements with running balances and attempt history.
- **Audit and operational visibility:** audit-event queries, transaction-attempt records, health/readiness endpoints, and ledger-derived reconciliation reports.
- **Abuse controls:** Redis-backed fixed-window rate limiting for registration, login, and money endpoints.
- **Web application:** Next.js App Router frontend that communicates through a same-origin `/api/*` proxy.
- **Controlled administration:** host-run first-admin bootstrap and admin-credential rotation commands; no request can self-assign the ADMIN role.

## Technology stack

| Area | Technology |
|---|---|
| Language | TypeScript (strict); JavaScript for migration and operational scripts; PL/pgSQL/SQL for database functions and constraints |
| Runtime | Node.js 22 or later |
| Frontend | Next.js 15 App Router, React 19 |
| API | Fastify 5, Zod request validation |
| Primary database | PostgreSQL 17 |
| Routine data access | Prisma 6 for non-financial CRUD |
| Financial data access | Parameterized SQL through `pg`; this is the only path for financial transactions |
| Schema migrations | `node-pg-migrate` (the sole migration authority) |
| Rate limiting | Redis 8 through `ioredis`; rate limits only, never financial or authorization state |
| Password hashing | Argon2 |
| Tests | Vitest for API and web workspaces |
| Local infrastructure | Docker Compose for PostgreSQL and Redis |

## Architecture

```text
Browser
  │ same-origin requests and HttpOnly session cookie
  ▼
Next.js web app (apps/web)
  │ /api/* rewrite; API origin stays server-side
  ▼
Fastify API (apps/api)
  ├── PostgreSQL 17 via raw pg ── financial transactions, ledger, identity data
  ├── PostgreSQL 17 via Prisma ── routine non-financial CRUD
  └── Redis 8 ─────────────────── rate limiting only
```

The web tier proxies browser requests to the API through `/api/*`, avoiding exposure of the API's internal origin to client-side code. The API validates inputs, authenticates the session, checks authorization, and calls domain logic. PostgreSQL is the source of truth for users, sessions, permissions, accounts, journals, ledger entries, idempotency records, audit events, and transaction attempts.

### Data-access boundaries

- **Raw `pg` SQL:** all financial postings and other operations requiring the financial transaction boundary. The SQL transaction owns locking, balance checks, journal/entry writes, cached balance updates, idempotency, and the result/attempt record as applicable.
- **Prisma:** routine non-financial CRUD, such as user/session workflows and other typed data access. Prisma is not used to issue financial statements.
- **`node-pg-migrate`:** the only tool used to apply schema migrations. Prisma migrations are not used.
- **Redis:** request-rate control only. It does not store balances, ledger history, idempotency outcomes, sessions, or permission authority.

Database access is split between `ledgerline_owner` (schema/migrations) and `ledgerline_app` (runtime). The runtime role is deliberately restricted; ledger and audit history are append-only for application writes.

## Financial model and algorithms

### Double-entry postings

A posted journal contains ledger entries with a positive `amount_minor` and a `DEBIT` or `CREDIT` direction. Each journal balances according to the ledger's debit/credit convention. A dedicated `EXTERNAL_CLEARING` system account provides the contra-entry for deposits and withdrawals; transfers post to both customer accounts. System-account balances are derived from ledger entries rather than treated as customer cached balances.

Customer account balances are cached for reads, but the cache is updated atomically with the corresponding journal entries. Reconciliation derives balances from `ledger_entries` and compares them with stored customer balances; system/clearing balances are ledger-derived. This allows fast account reads while retaining a way to verify the read model against the immutable ledger.

### Money and serialization

Amounts are positive integer minor units. For example, `₹125.50` is represented as `12550` paise. The API accepts and returns money and event-sequence values as decimal strings, avoiding JavaScript number precision loss and floating-point rounding. Currency codes are stored and validated; cross-currency transfers are refused.

### Financial-operation transaction flow

A deposit, withdrawal, or transfer follows a transaction-oriented flow:

1. Revalidate the session and relevant actor/account grants using database state; do not trust role or permission claims from the browser.
2. Claim the idempotency key in PostgreSQL, scoped to actor and operation. Compare the canonical request hash when a key already exists.
3. Validate request-level invariants, such as positive amount, supported amount range, distinct transfer accounts, matching currencies, and allowed account kinds.
4. Lock the involved customer account rows with `SELECT ... FOR UPDATE` in deterministic account-ID order. This prevents concurrent transactions from making decisions based on stale balances and reduces deadlock risk.
5. Under the lock, check active account status and sufficient funds. Refuse withdrawals/transfers that would overdraw an account.
6. Write the journal and balanced entries, allocate account event sequence numbers, and update customer cached balances.
7. Store the operation outcome for idempotent replay and commit. If the operation fails unexpectedly, the transaction rolls back as a unit.

Authorization refusals and business refusals are recorded as attempts according to their respective transaction paths; a refusal is not represented as a successful journal transaction. Replays re-check current session and permission visibility before returning a stored outcome. Reusing the same key with a different request payload returns a conflict rather than reinterpreting the key.

### Concurrency and event ordering

PostgreSQL row locks serialize balance-sensitive operations on the same customer account. Transfers lock all involved accounts in sorted ID order, then validate the source balance and write both sides of the transfer in one transaction. Per-account event sequence counters provide ordered statement positions for committed postings and applicable under-lock refusals. Statement reads merge ledger events with transaction attempts using those sequence values and cursor-based pagination.

### Security and access algorithms

- Passwords are hashed with Argon2.
- Login creates an opaque session token; the browser receives it as an HttpOnly cookie while the database stores a hash of the token. Sessions have an expiry and can be revoked at logout.
- Role and account grants are loaded from the database for authorization. Registration creates an `ACCOUNT_HOLDER` without accounts, grants, or money authority.
- Mutating browser requests are checked against the configured allowed origin (`APP_ORIGIN`), providing a CSRF control compatible with the web proxy.
- Redis applies fixed-window rate limits to registration, login, and money-operation route classes. It is an availability control, not an authority store.
- Financial/audit history is append-only from the runtime application's perspective. Audit records are committed with the state changes they describe where applicable.

## Roles and permissions

| Role | Capabilities |
|---|---|
| `ADMIN` | Manage users, roles, accounts, account grants, and audit/reconciliation views; deposits are ADMIN-only. Administrators still need the source `TRANSFER` grant to make a transfer. |
| `ACCOUNT_HOLDER` | Access accounts granted to them and perform the actions authorized by those account grants, such as viewing, withdrawing, or transferring. |
| `AUDITOR` | Read-only access to audit and reconciliation information and the applicable account/transaction views. |

Account grants use permission names such as `VIEW`, `WITHDRAW`, and `TRANSFER`. Permissions are operation-specific: a grant for one action does not implicitly grant another. Invisible and nonexistent account-scoped resources use a uniform not-found response to reduce resource enumeration.

## API functionality

All browser-facing API traffic uses the same-origin `/api/*` path. Money values and sequence numbers in request/response JSON are strings. Non-success responses use an error object with a stable code and message.

| Method and path | Function |
|---|---|
| `GET /health` | Liveness check. |
| `GET /ready` | Readiness checks for PostgreSQL and Redis. |
| `POST /register` | Self-service account-holder registration; role is fixed by the server. |
| `POST /login` | Authenticate and issue the `bv_session` HttpOnly cookie. |
| `POST /logout` | Revoke the current session and clear its cookie. |
| `GET /accounts` | List accounts visible to the authenticated actor. |
| `POST /accounts` | Create an account (ADMIN). |
| `GET /accounts/:accountId` | Read an account visible to the actor. |
| `GET /accounts/:accountId/statement` | Read paginated account activity, running balances, and attempts. |
| `POST /accounts/:accountId/deposits` | Post an ADMIN-authorized deposit with an `Idempotency-Key`. |
| `POST /accounts/:accountId/withdrawals` | Post an authorized withdrawal with an `Idempotency-Key`. |
| `POST /transfers` | Transfer between accounts with an `Idempotency-Key`. |
| `GET /transactions/:transactionId` | Read a transaction subject to account visibility. |
| `GET /audit/events` | Query audit events (ADMIN/AUDITOR). |
| `GET /reconciliation/summary` | Read system-wide conservation and account reconciliation summary (ADMIN/AUDITOR). |
| `GET /reconciliation/accounts/:accountId` | Compare an account's stored balance with its ledger-derived balance (ADMIN/AUDITOR). |
| `POST /users` | Create a user with an assigned role (ADMIN). |
| `PATCH /users/:userId/role` | Change a user's role (ADMIN), protecting the last administrator. |
| `POST /account-permissions` | Grant account permission (ADMIN). |
| `DELETE /account-permissions` | Revoke account permission (ADMIN). |

See [`ledgerline-repo-kit/docs/API.md`](ledgerline-repo-kit/docs/API.md) and [`API_CONTRACT.md`](ledgerline-repo-kit/docs/API_CONTRACT.md) for request/response schemas, detailed authorization rules, refusal codes, and endpoint-level transaction behavior.

## Repository structure

```text
.
├── apps/
│   ├── api/                      Fastify API, domain logic, tests, scripts, Prisma schema
│   │   ├── src/auth/             Session and authentication logic
│   │   ├── src/domain/           Money, permissions, statements, invariants, transaction runner
│   │   ├── src/http/             Fastify app, guards, error mapping, and route handlers
│   │   ├── src/infrastructure/   PostgreSQL, Prisma, Redis, Argon2, rate limiter
│   │   └── test/                 API unit, integration, and route tests
│   └── web/                      Next.js App Router UI and same-origin API proxy config
├── db/migrations/                PostgreSQL schema and privilege migrations
├── ledgerline-repo-kit/docs/     Architecture, API, security, data model, deployment, ADRs
├── docker-compose.yml            Local PostgreSQL 17 and Redis 8 services
├── package.json                  npm workspaces and root-level commands
└── .env.example                  Local and deployment environment-variable template
```

## Getting started

### Prerequisites

- Node.js 22 or newer and npm.
- Docker with Docker Compose.
- A local `.env` populated with unique, strong passwords in place of all `CHANGE_ME_*` values.

### Install and start services

From the repository root (commands shown for PowerShell; use `cp .env.example .env` on macOS/Linux):

```powershell
npm install
Copy-Item .env.example .env
# Edit .env and replace every CHANGE_ME_* placeholder with a unique secret.
docker compose up -d
```

Initialize the database roles, then apply schema migrations:

```powershell
npm run db:migrate:bootstrap
npm run db:migrate
```

Start the API and frontend in separate terminals:

```powershell
npm run dev:api
npm run dev:web
```

The API listens on port `4000` by default, and the web app runs on port `3000`. Local PostgreSQL and Redis are exposed on loopback ports `15432` and `16379` by default. Check API liveness at `http://localhost:4000/health` and readiness at `http://localhost:4000/ready`.

## Demo users and data

Create a first administrator through the controlled host-side bootstrap command. This command does not accept a role from a request and does not print the password:

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:BOOTSTRAP_ADMIN_PASSWORD="<demo-only strong password>"
node --env-file=.env apps/api/scripts/bootstrap.mjs
```

Create demo users and accounts with the idempotent seed script:

```powershell
$env:DEMO_SEED_PASSWORD="<demo-only strong password>"
$env:DEMO_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:DEMO_ADMIN_PASSWORD="<demo-only strong password>"
node --env-file=.env apps/api/scripts/seed-demo.mjs
```

The demo includes an `ADMIN`, an `ACCOUNT_HOLDER`, and an `AUDITOR`, plus `DEMO-HOLDER-ACCOUNT` and `DEMO-COUNTER-ACCOUNT`. The seed uses stable account numbers and idempotency keys, so re-running it does not duplicate financial postings. Demo credentials are for local demonstration only; use new secrets and credentials in any other environment.

## Environment configuration

Copy `.env.example` to `.env`. Important settings include:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime application's PostgreSQL connection (`ledgerline_app`). |
| `DATABASE_URL_OWNER` | Owner connection used for schema migrations. |
| `DATABASE_URL_BOOTSTRAP` | Bootstrap connection used to create database roles. |
| `POSTGRES_BOOTSTRAP_PASSWORD`, `OWNER_ROLE_PASSWORD`, `APP_ROLE_PASSWORD` | Local database bootstrap and role passwords. Set unique values. |
| `REDIS_URL` | Redis connection for rate limiting only. |
| `SESSION_TTL_SECONDS` | Session lifetime. |
| `COOKIE_SECURE` | Set to `true` in production; production API startup requires secure cookies. |
| `APP_ORIGIN` | API allow-list for browser-originated mutations; required in production. |
| `API_INTERNAL_URL` | Server-side API origin used by the web `/api/*` rewrite; required for production build/runtime. |
| `RATE_LIMIT_*` | Registration, login, and money-operation fixed-window limits. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Host environment values for first-admin bootstrap; do not commit secrets. |

The Compose file binds database and Redis ports to `127.0.0.1`. Production secrets must be supplied by the deployment platform, not committed to the repository. The web API origin must remain server-side; do not expose it through a `NEXT_PUBLIC_*` variable.

## Testing and quality checks

```powershell
npm test                             # API Vitest suite
npm run test --workspace apps/web    # Web Vitest suite
npm run lint                         # Lint both workspaces
npm run typecheck                    # Type-check API and web workspaces
npm run build --workspace apps/web   # Production web build (requires API_INTERNAL_URL)
```

The API tests exercise domain, HTTP, and integration behavior with PostgreSQL and Redis; the web workspace has its own Vitest suite. To run the API integration tests locally, first configure `.env`, start the Compose services, and apply migrations. The migration commands are `npm run db:migrate:bootstrap` for initial role setup and `npm run db:migrate` for schema migrations.

## Deployment

The project has a deployed frontend and API:

- **Frontend:** [snovasis-assignment-seven.vercel.app](https://snovasis-assignment-seven.vercel.app)
- **Backend:** [snovasis-assignment.onrender.com](https://snovasis-assignment.onrender.com) (`/health` and `/ready`)

The documented topology uses Vercel for the web frontend, Render for the API, Neon for PostgreSQL, and Upstash for Redis. Configure `API_INTERNAL_URL` on the web deployment and `APP_ORIGIN`, secure cookies, database connections, and Redis credentials on the API. Review [`ledgerline-repo-kit/docs/DEPLOYMENT.md`](ledgerline-repo-kit/docs/DEPLOYMENT.md) for the full deployment configuration and operational steps.

## Detailed documentation

- [Architecture](ledgerline-repo-kit/docs/ARCHITECTURE.md)
- [API reference](ledgerline-repo-kit/docs/API.md) and [API contract](ledgerline-repo-kit/docs/API_CONTRACT.md)
- [Data model](ledgerline-repo-kit/docs/DATA_MODEL.md)
- [Authorization matrix](ledgerline-repo-kit/docs/AUTHZ_MATRIX.md)
- [Idempotency behavior](ledgerline-repo-kit/docs/IDEMPOTENCY_BEHAVIORS.md)
- [Refusal codes](ledgerline-repo-kit/docs/REFUSAL_CODES.md)
- [Audit coverage](ledgerline-repo-kit/docs/AUDIT_COVERAGE.md)
- [Deployment guide](ledgerline-repo-kit/docs/DEPLOYMENT.md)
- [Threat register](ledgerline-repo-kit/THREATS.md)
- [Architecture decision records](ledgerline-repo-kit/docs/adr/)
