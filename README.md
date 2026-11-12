# Snovasis_Assignment

BalanceVault — a double-entry ledger application (LedgerLine expanded challenge).

**Purpose.** Money moves are conserved, duplicate requests never move money
twice, concurrent operations cannot overspend an account, and every accepted or
refused attempt can be explained from durable records.

## Stack

Node.js 22 · TypeScript (strict) · Fastify 5 + zod · PostgreSQL 17 (raw `pg`
money path, Prisma routine path) · node-pg-migrate (sole migration authority) ·
Redis 8 (rate limiting only) · Vitest (API + web) · Next.js 15 (App Router).

## Architecture

```
browser ──same-origin /api/*──> Next.js (apps/web) ──rewrite──> Fastify (apps/api)
   │                              (session cookie)                    │
   └──────────────────────────────► HTTPOnly cookie                    ├─ raw pg ──> PostgreSQL 17
                                                                     │            (financial truth,
                                                                     │             double-entry, append-only)
                                                                     └─ Redis 8  (rate limiting only)
```

- **Raw `pg` owns every financial transaction** — one transaction per operation,
  owning the locks, the balance check, the journal, the ledger entries, the
  idempotency claim and the attempt row (ADR-005).
- **Prisma** performs routine non-financial CRUD only (users, sessions, grants,
  audit reads) — never a financial statement (T-062).
- **node-pg-migrate** is the only migration authority; `prisma migrate` is never
  invoked.
- **Redis** never holds balances, ledger, idempotency or authority state — it is
  an availability control only (T-060).
- **Money is integer paise / `BigInt`** end to end — never floating point.
- Normative documents: `ledgerline-repo-kit/docs/` (architecture, ADRs, authz
  matrix, data model, idempotency behaviours, refusal codes, threat register).

## Setup from a clean clone

```powershell
npm install                # workspaces: apps/api + apps/web; runs prisma generate
cp .env.example .env       # then REPLACE every CHANGE_ME_* with generated secrets
docker compose up -d       # PostgreSQL 17 + Redis 8 (loopback-only ports 15432/16379)
npm run db:migrate:bootstrap   # creates ledgerline_owner / ledgerline_app (bootstrap superuser)
npm run db:migrate             # all further migrations (as ledgerline_owner)
```

Then create the first administrator and the demo data (see below), and run the
two tiers:

```powershell
npm run dev:api                # API on :4000  → GET /health, GET /ready
npm run dev:web                # web on :3000
```

## Seed credentials (demo only)

The first administrator is created by the **controlled bootstrap process** — it
never accepts a role from a request and it prints no password:

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:BOOTSTRAP_ADMIN_PASSWORD="<demo-only password>"
node --env-file=.env apps/api/scripts/bootstrap.mjs
```

The demo users and accounts come from the **idempotent demo seed** (running it
twice is safe — fixed account numbers and fixed idempotency keys replay instead
of double-posting, T-044):

```powershell
$env:DEMO_SEED_PASSWORD="<demo-only password>"
$env:DEMO_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:DEMO_ADMIN_PASSWORD="<demo-only password>"
node --env-file=.env apps/api/scripts/seed-demo.mjs
```

| Role | Email | Notes |
|---|---|---|
| ADMIN | `demo.admin@balancevault.local` | created by the bootstrap command above |
| ACCOUNT_HOLDER | `demo.holder@balancevault.local` | holds VIEW/TRANSFER/WITHDRAW on `DEMO-HOLDER-ACCOUNT` |
| AUDITOR | `demo.auditor@balancevault.local` | read-only: audit events + reconciliation |

Demo accounts: `DEMO-HOLDER-ACCOUNT` (250,000 deposited, 50,000 transferred out)
and `DEMO-COUNTER-ACCOUNT` (50,000 received). **Every demo password is
demo-only** and must be rotated for any real deployment.

## Live URL

Not deployed yet — the submission host must set `API_INTERNAL_URL` (web tier)
and `APP_ORIGIN` (API tier) and run `prisma generate` for its platform. See
[`ledgerline-repo-kit/docs/DEPLOYMENT.md`](ledgerline-repo-kit/docs/DEPLOYMENT.md)
for the exact deployment and verification steps. *(Fill in the public URL when
the deployment exists.)*

## Commands

```powershell
npm test                             # API: 26 files / 200 tests against real PostgreSQL 17 + Redis
npm run test --workspace apps/web    # web: 4 files / 41 tests
npm run lint                         # both workspaces
npm run typecheck                    # both workspaces
npm run build --workspace apps/web   # production build (needs API_INTERNAL_URL)
npm run db:migrate                   # node-pg-migrate (the only migration authority)
```

## Environment highlights

| Variable | Where | Why |
|---|---|---|
| `APP_ORIGIN` | API | Comma-separated allowed browser origins for mutating requests. **Required in production** — the `/api/*` rewrite rewrites the upstream `Host` header, so a same-origin comparison cannot work (CSRF origin policy, ADR-006 item 3). |
| `API_INTERNAL_URL` | web | Internal API origin for the `/api/*` rewrite. **Required in production** — `next build`/`next start` fail fast instead of proxying production traffic to `localhost`. Never a `NEXT_PUBLIC_*` variable. |
| `COOKIE_SECURE` | API | Must be `true` in production; the API refuses to start otherwise. |

Full reference: [`ledgerline-repo-kit/docs/DEPLOYMENT.md`](ledgerline-repo-kit/docs/DEPLOYMENT.md).

## Invariants

- Money path is 100% raw parameterised SQL via `pg` in ONE transaction per financial operation (ADR-005).
- Prisma: routine non-financial CRUD only, same DB, same `ledgerline_app` role; `prisma migrate` is NEVER used.
- Redis: rate limiting only — never balances, ledger, idempotency or audit authority.
- Two DB roles: `ledgerline_owner` (migrations/DDL) vs `ledgerline_app` (runtime; append-only enforced).
- Every state change and its audit event commit together or roll back together ([`AUDIT_COVERAGE.md`](ledgerline-repo-kit/docs/AUDIT_COVERAGE.md)).
- Idempotency, concurrency safety, no overdrafts, append-only audit: see `ledgerline-repo-kit/docs/`.

## Known limitations (honest list)

1. **No production deployment yet** — the deployment steps are documented and
   the compiled artefacts boot locally, but no public URL exists.
2. **No browser end-to-end suite** — the API has 200 real-database tests and the
   web tier has 41 unit tests; the user journey was verified manually through
   the real proxy (register → login → accounts → deposit → statement → logout).
3. **`postcss` advisories via `next@15.5.29`** — build-time only, no
   non-breaking fix exists (T-063, OPEN; owner decision required).
4. **The T-042 attempt-write cap is best-effort**, not a strict hard cap (the
   count and the insert are not serialised) — disclosed in `THREATS.md`.
5. **The `LOGIN_FAILED` audit row is written best-effort** — a failure is
   logged, never surfaced, and the uniform 401 is preserved (AUTH-005).
6. **Bootstrap/rotation operator identity is a claim, not proof** — accepted
   residual risk T-050.
7. **`npm run format:check` reports pre-existing files** — prettier is not a CI
   gate; only files authored in the last pass are formatted.
