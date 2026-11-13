# Phase 4: Repository foundation and a deployed walking skeleton

**Target:** Fri 6 to Sat 7 Nov. **Agents:** 05 backend, 09 devops. **Skills:** clean-architecture-guard, phase-runner.

## Objective
A clean clone installs, migrates, tests and **runs on a public URL** with `/health` and a database round trip. Deploying now removes the biggest late-week risk.

## Tasks
- [ ] P4.1 Monorepo: `apps/api`, `apps/web`, `db/migrations`; npm workspaces; TypeScript strict; ESLint + Prettier.
- [ ] P4.2 `docker-compose.yml` PostgreSQL; `.env.example` (placeholders only); config parsing with zod that fails fast.
- [ ] P4.3 Migration runner; first migration creates the two roles `ledgerline_owner` and `ledgerline_app` (see ADR-005). Verify the chosen host lets you create a second role. If not, record it and decide (H-4) now.
- [ ] P4.4 Fastify app factory (`buildApp(deps)`), error mapper, request-id, structured logs with redaction, `GET /health` and `GET /ready` (DB ping, no details).
- [ ] P4.5 Vitest wired with a real-PostgreSQL test harness: a fresh schema per test file, helper to open **independent** connections.
- [ ] P4.6 `assertGlobalInvariants(db)` helper stub (filled in Phase 6).
- [ ] P4.7 GitHub Actions: install, lint, typecheck, migrate on a PostgreSQL service container, test.
- [ ] P4.8 Deploy API + DB (+ minimal web page) to the chosen hosts; set secrets in host env; verify `/health` from a phone on another network.
- [ ] P4.9 Fill the Commands block in `CLAUDE.md`; record exact versions.

### BalanceVault expansion additions (2026-11-09 — additive; the original P4.1–P4.9 order and wording are unchanged and remain authoritative)

- [ ] P4.2+ Add **Redis** to `docker-compose.yml` (dev password via env var; no secrets committed) and expose `REDIS_URL` in `.env.example`. Redis is for API rate limiting only — never financial state (`docs/ARCHITECTURE.md`, BalanceVault expansion; `THREATS.md` T-060).
- [ ] P4.3+ Add `prisma` workspace configuration: `schema.prisma` mirroring the node-pg-migrate schemas, `prisma generate` wired into install/build; `DATABASE_URL` = the same `ledgerline_app` connection as raw SQL. **Prisma migrate is not used** (single migration authority — `ADR-005`).
- [ ] P4.4+ `/ready` semantics expanded (still no credential details): PostgreSQL ping + **Redis ping**; distinct `/health` liveness unchanged.
- [ ] P4.5+ Prisma client imports into the scaffold with a typecheck-level smoke query in the integration harness (routine path only; money path stays raw SQL by construction).
- [ ] P4.8+ Before P4.8 deployment verification (unchanged H-4 window): PRODROLE-001 — production runtime role `ledgerline_app` supports BOTH raw-SQL and Prisma connections; hosting verifications recorded.

## Allowed files
Everything needed for scaffolding. **No domain logic yet.**

## Acceptance (Gate 4)
From a fresh clone: documented commands succeed; CI is green; the live `/health` responds; evidence pasted in the phase report.

## Closeout
Suggested commits: `chore: scaffold monorepo`, `ci: add pipeline with postgres`, `chore(deploy): walking skeleton`.
