"# Snovasis_Assignment

BalanceVault — double-entry ledger application (LedgerLine expanded challenge).

## Stack

Node.js 22 · TypeScript (strict) · Fastify + zod · PostgreSQL 17 (raw `pg` money path, Prisma routine path) · node-pg-migrate (sole migration authority) · Redis 8 (rate limiting only) · Vitest + Playwright (later) · Docker Compose · Next.js (minimal — polish in Phase 11)

## Setup from a clean clone

```powershell
npm install                # workspaces: apps/api + apps/web; runs prisma generate
cp .env.example .env       # then REPLACE every CHANGE_ME_* with generated secrets
docker compose up -d       # PostgreSQL 17 + Redis 8 (loopback-only ports 15432/16379)
npm run db:migrate:bootstrap   # creates ledgerline_owner / ledgerline_app (runs as bootstrap superuser)
npm run db:migrate             # all further migrations (runs as ledgerline_owner)
npm test                       # real-PostgreSQL integration tests
npm run dev:api                # API on :4000  → GET /health, GET /ready
npm run dev:web                # web on :3000
```

## Invariants (normative docs in `ledgerline-repo-kit/`)

- Money path is 100% raw parameterised SQL via `pg` in ONE transaction per financial operation (ADR-005).
- Prisma: routine non-financial CRUD only, same DB, same `ledgerline_app` role; `prisma migrate` is NEVER used.
- Redis: rate limiting only — never balances, ledger, idempotency or audit authority.
- Two DB roles: `ledgerline_owner` (migrations/DDL) vs `ledgerline_app` (runtime; append-only enforced).
- Idempotency, concurrency safety, no overdrafts, append-only audit: see `ledgerline-repo-kit/docs/`.
"
