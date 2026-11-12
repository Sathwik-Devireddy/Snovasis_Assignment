# Snovasis_Assignment

BalanceVault — double-entry ledger application (LedgerLine expanded challenge).

## Stack

Node.js 22 · TypeScript (strict) · Fastify + zod · PostgreSQL 17 (raw `pg` money path, Prisma routine path) · node-pg-migrate (sole migration authority) · Redis 8 (rate limiting only) · Vitest (API + web) · Playwright (E2E, where the environment supports it) · Docker Compose · Next.js 15 (App Router)

## Setup from a clean clone

```powershell
npm install                # workspaces: apps/api + apps/web; runs prisma generate
cp .env.example .env       # then REPLACE every CHANGE_ME_* with generated secrets
docker compose up -d       # PostgreSQL 17 + Redis 8 (loopback-only ports 15432/16379)
npm run db:migrate:bootstrap   # creates ledgerline_owner / ledgerline_app (runs as bootstrap superuser)
npm run db:migrate             # all further migrations (runs as ledgerline_owner)
npm test                       # full API suite against real PostgreSQL + Redis
npm run dev:api                # API on :4000  → GET /health, GET /ready
npm run dev:web                # web on :3000
```

## Environment highlights

| Variable | Where | Why |
|---|---|---|
| `APP_ORIGIN` | API | Comma-separated allowed browser origins for mutating requests. **Required in production** — the `/api/*` rewrite rewrites the upstream `Host` header, so a same-origin comparison cannot work (CSRF origin policy, ADR-006 item 3). |
| `API_INTERNAL_URL` | web | Internal API origin for the `/api/*` rewrite. **Required in production** — `next build`/`next start` fail fast instead of proxying production traffic to `localhost`. Never a `NEXT_PUBLIC_*` variable. |
| `COOKIE_SECURE` | API | Must be `true` in production; the API refuses to start otherwise. |

Full reference: [`ledgerline-repo-kit/docs/DEPLOYMENT.md`](ledgerline-repo-kit/docs/DEPLOYMENT.md).

## Tests

```powershell
npm test                          # API: 25 files / 191 tests against real PostgreSQL 17 + Redis
npm run test -w apps/web          # web: 4 files / 41 tests
npm run lint                      # both workspaces
npm run typecheck                 # both workspaces
npm run build -w apps/web         # production build (needs API_INTERNAL_URL)
```

## Invariants (normative docs in `ledgerline-repo-kit/`)

- Money path is 100% raw parameterised SQL via `pg` in ONE transaction per financial operation (ADR-005).
- Prisma: routine non-financial CRUD only, same DB, same `ledgerline_app` role; `prisma migrate` is NEVER used.
- Redis: rate limiting only — never balances, ledger, idempotency or audit authority.
- Two DB roles: `ledgerline_owner` (migrations/DDL) vs `ledgerline_app` (runtime; append-only enforced).
- Money is integer paise / BigInt only — never floating point. Ids are validated against the signed BIGINT boundary before they reach the database.
- Every state change and its audit event commit together or roll back together ([`AUDIT_COVERAGE.md`](ledgerline-repo-kit/docs/AUDIT_COVERAGE.md)).
- Idempotency, concurrency safety, no overdrafts, append-only audit: see `ledgerline-repo-kit/docs/`.
