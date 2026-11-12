# Deployment & Environment Reference

Exact setup and verification steps for BalanceVault (LedgerLine). Every command
below was executed against the real stack (PostgreSQL 17 + Redis 8 + Fastify +
Next.js) unless marked otherwise.

## 1. Topology

```
browser ──HTTP(S)──> Next.js (apps/web)  ──/api/* rewrite──> Fastify (apps/api)
                        │                                        │
                        │ cookies (HttpOnly)                     │ raw pg
                        ▼                                        ▼
                   session cookie                        PostgreSQL 17 (financial truth)
                                                                ▲
                                                        Redis 8 (rate limiting only)
```

* The browser NEVER talks to the API directly: all calls go to the same-origin
  `/api/*` path, which the Next.js rewrite proxies to the internal API origin.
* The API never trusts a role, a permission, an account id or an ownership
  claim from the client — everything is re-derived from the database.

## 2. Environment variables

### API (`apps/api`) — fail-fast at boot (`src/config.ts`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Runtime role `ledgerline_app`. Raw-pg money path AND Prisma routine path. |
| `DATABASE_URL_OWNER` | yes | — | Role `ledgerline_owner`; migrations/DDL only. Must differ from `DATABASE_URL` (enforced). |
| `DATABASE_URL_BOOTSTRAP` | yes | — | Bootstrap superuser; role provisioning only. |
| `REDIS_URL` | yes | — | `redis://` or `rediss://`. Rate limiting ONLY. |
| `PORT` | no | `4000` | API listen port. |
| `NODE_ENV` | no | `development` | `production` enables the strict checks below. |
| `LOG_LEVEL` | no | `info` | `trace\|debug\|info\|warn\|error`. |
| `SESSION_TTL_SECONDS` | no | `43200` | Session lifetime. |
| `COOKIE_SECURE` | no | `false` | **Must be `true` in production** (the API refuses to start otherwise). |
| `APP_ORIGIN` | **yes in production** | — | Comma-separated allowed browser origins for mutating requests, e.g. `https://app.example.com`. Required in production because the `/api/*` rewrite rewrites the upstream `Host` header, so a same-origin comparison is impossible (see §6). |
| `RATE_LIMIT_REGISTER_LIMIT` / `_WINDOW_SECONDS` | no | `10` / `3600` | Pre-auth register limiter (IP-keyed). |
| `RATE_LIMIT_LOGIN_LIMIT` / `_WINDOW_SECONDS` | no | `10` / `300` | Pre-auth login limiter (IP-keyed). |
| `RATE_LIMIT_MONEY_LIMIT` / `_WINDOW_SECONDS` | no | `60` / `60` | Money limiter (actor-keyed). |
| `OWNER_ROLE_PASSWORD`, `APP_ROLE_PASSWORD` | migration only | — | Consumed by migration 0001 when run as the bootstrap superuser. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | bootstrap only | — | First-admin bootstrap host command; never in the repository. |
| `LEDGERLINE_OPERATOR_ID`, `ROTATE_ADMIN_EMAIL`, `ROTATE_ADMIN_PASSWORD`, `BOOTSTRAP_ALLOW_ROTATION_CI` | rotation only | — | Credential-rotation host command. |

### Web (`apps/web`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `API_INTERNAL_URL` | **yes in production** | — | Internal API origin used by the `/api/*` rewrite, e.g. `http://api:4000`. Server-side only — **never** a `NEXT_PUBLIC_*` variable (the internal address must not leak to the browser). `next build`/`next start` FAIL FAST when it is missing or malformed (not an http(s) URL, or carrying a path/query/fragment). In development it defaults to `http://localhost:4000`. |

## 3. Local development (verified)

```powershell
npm install                       # workspaces + `prisma generate` (postinstall)
cp .env.example .env              # replace every CHANGE_ME_* with generated secrets
docker compose up -d              # PostgreSQL 17 (127.0.0.1:15432) + Redis 8 (127.0.0.1:16379)
npm run db:migrate:bootstrap      # creates ledgerline_owner / ledgerline_app
npm run db:migrate                # all further migrations (as ledgerline_owner)
npm test                          # full API suite against the real DB + Redis
npm run dev:api                   # API on :4000  → GET /health, GET /ready
npm run dev:web                   # web on :3000
```

Verification:

```powershell
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:4000/ready          # per-component PG/Redis status
Invoke-WebRequest http://localhost:3000/accounts -UseBasicParsing   # homepage renders
```

`docker compose ps` must show both services `healthy`. The API refuses to start
against the owner credentials, and the readiness endpoint reports Redis
degradation instead of failing the process (fail-soft, T-060).

## 4. Migrations

`node-pg-migrate` is the ONLY migration authority; `prisma migrate` is never
invoked.

```powershell
npm run db:migrate:bootstrap   # FIRST TIME ONLY — as the bootstrap superuser
npm run db:migrate             # every later migration — as ledgerline_owner
```

Do NOT run migrations automatically from multiple application replicas: run
them once (a deploy job / release step) before the new replicas start.

## 5. Production configuration

Minimum for a production deployment:

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` (enforced) |
| `APP_ORIGIN` | the browser-facing origin(s), comma-separated (enforced) |
| `API_INTERNAL_URL` | the internal API origin for the web tier (enforced at build/start) |
| `DATABASE_URL` | `postgresql://ledgerline_app:…@db:5432/balancevault` |
| `REDIS_URL` | `redis://redis:6379` (TLS + ACLs recommended) |

Build and start the web tier:

```bash
API_INTERNAL_URL=http://api:4000 npm run build -w apps/web   # rewrites are baked at build time
npm run start -w apps/web
```

`next build` evaluates `rewrites()`, so `API_INTERNAL_URL` must be present at
BUILD time as well as at start time.

## 6. CSRF origin policy (why `APP_ORIGIN` exists)

Mutating routes require `Content-Type: application/json` and an acceptable
`Origin` header (ADR-006 item 3). The Next.js `/api/*` rewrite proxies with
`changeOrigin: true`, so the upstream `Host` header is the API origin while the
browser's host survives in `x-forwarded-host`. Comparing `Origin` with `Host`
therefore never matches in the deployed topology.

Policy (`apps/api/src/http/origins.ts`):

1. No `Origin` header (server-to-server clients) → allowed; the session cookie
   and SameSite policy remain the real defences.
2. `APP_ORIGIN` allow-list → the origin must be on it (production).
3. `Origin` host == the API's own `Host` (direct same-origin call) → allowed.
4. `x-forwarded-host` is honoured ONLY when no allow-list is configured
   (development/test). In production a client-supplied forwarded header is
   never trusted.

## 7. Health, readiness and graceful shutdown

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness — process is up. |
| `GET /ready` | readiness — per-component PostgreSQL/Redis status (`ok`/`unavailable`), 200 when healthy, 503 otherwise. Redis degradation is reported, never fatal for financial correctness. |

The API closes the pg pool, the Redis client and the Prisma client on
shutdown; the Fastify server stops accepting new connections first.

## 8. Operations checklist

1. `docker compose ps` → both services healthy.
2. `npm run db:migrate` → "No migrations to run" (already current).
3. `npm test` (API) and `npm run test -w apps/web` → green.
4. `GET /health` → 200; `GET /ready` → 200 with both components `ok`.
5. Browser: register → login → view accounts → deposit → statement → logout.
   The browser calls only same-origin `/api/*`; the API answers 400
   "Request origin not allowed." if `APP_ORIGIN` is misconfigured — that is the
   intended loud failure.
6. `docker compose logs api` → no repeated 500s.

## 9. Secrets

* `.env` is gitignored; only `.env.example` (placeholders) is committed.
* Session tokens are opaque, stored hashed, and never returned to JavaScript.
* Passwords are argon2id; plaintext never reaches a log or an audit row.
* No credential is printed by the bootstrap/rotation scripts.
