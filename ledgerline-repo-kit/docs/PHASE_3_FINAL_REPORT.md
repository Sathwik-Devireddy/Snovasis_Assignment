# Phase 3 Final Report — Security, Release Readiness & Submission Preparation

*Date: 2026-11-14 · Baseline: `main` @ `66f2b29` · Phase 3 work performed by the engineering agent under the owner's Phase 3 instruction · **Phase 3 documentation commit: `59a3203`** (this line was added in the immediate follow-up docs commit — a commit cannot reference its own hash)*

## 1. Initial repository state

- **Branch/commit:** `main` @ `66f2b29` ("Phase 3 baseline"), descendant of the
  Phase 1 (`98d491a`) and Phase 2 (`619c10f`) commits; all pushed.
- **CI:** latest run at baseline `43429125834` — **success** (api + web jobs),
  head sha `66f2b29a…`.
- **Working tree (pre-existing, preserved untouched):** the human's Neon
  tooling — modified `.gitignore` (+`.neon`), `package.json` (+`@neon/config`,
  `@neon/env`), `package-lock.json`, untracked `neon.ts`, `.neon/`; plus
  `dump.rdb` and two `.tmp-*.log` files. Per the Phase 3 rules none of these
  were committed, modified or deleted.
- **Local stack:** Docker PostgreSQL 17 (`127.0.0.1:15432`) and Redis 8
  (`127.0.0.1:16379`) healthy (28h uptime). The long-running dev servers from
  Phase 2 were not running (session restart); test suites boot the app
  in-process, so they were not needed for verification. The local DB carries
  ~800 old test-fixture accounts (harmless) plus the demo/qa data.
- **Docs baseline:** `ledgerline-repo-kit/docs/` complete for architecture,
  authz, refusals, idempotency, threats, testing, deployment, interview prep;
  `reports/PHASE-01/02/…-report.md` history intact.

## 2. What Phase 3 did (and deliberately did not do)

Phase 3 is a verification/documentation phase on top of the verified Phase 1/2
implementation. **No application code was changed and no rebuild occurred.**
The only modifications are the seven new Phase 3 documents, pointer/accuracy
updates to existing docs, and the dated `PROMPTS.md` entry.

### Files modified/created by Phase 3 (this working set)

| File | Change |
|---|---|
| `ledgerline-repo-kit/docs/PHASE_3_FINAL_REPORT.md` | **new** — this report |
| `ledgerline-repo-kit/docs/SECURITY_REVIEW.md` | **new** — code-level security review, severity-classified findings |
| `ledgerline-repo-kit/docs/FINANCIAL_INTEGRITY_EVIDENCE.md` | **new** — invariant→evidence map + live probe results |
| `ledgerline-repo-kit/docs/REQUIREMENT_TRACEABILITY.md` | **new** — requirement/invariant/success-criteria matrix |
| `ledgerline-repo-kit/docs/DEMO_RUNBOOK.md` | **new** — repeatable 13-step local demo |
| `ledgerline-repo-kit/docs/SUBMISSION_CHECKLIST.md` | **new** — submission package + owner actions |
| `ledgerline-repo-kit/docs/INTERVIEW_PREPARATION.md` | **new** — Q&A tied to the actual code |
| `README.md` | **update** — test counts corrected (202/48), deployment status corrected, Phase 3 doc pointers, limitations refreshed |
| `ledgerline-repo-kit/docs/WRITEUP.md` | **update** — Phase 3 verification pointers + limitation statuses |
| `ledgerline-repo-kit/docs/DEPLOYMENT.md` | **update** — verification commands used this phase + the BLOCKED deposit note |
| `ledgerline-repo-kit/docs/INTERVIEW_PREP.md` | **update** — pointer to `INTERVIEW_PREPARATION.md` |
| `ledgerline-repo-kit/PROMPTS.md` | **update** — dated Phase 3 entry (incl. disclosed gap for 2026-11-13 entries) |

**No code, tests, migrations, dependencies or CI configuration changed.** No
regression test was needed — no genuine defect was found requiring a fix (see
§4).

## 3. Security review (summary; full detail in SECURITY_REVIEW.md)

Code-level review across authentication, authorization, database roles, API
security and frontend. **CRITICAL: 0. HIGH: 0.**

- **S-1 (MEDIUM, owner decision):** login/register rate-limit buckets are
  IP-keyed while `trustProxy: false` behind Render's router → production
  clients share one bucket. Availability concern; financial integrity
  unaffected (durable T-042 cap + locks are the real controls). Options
  documented; not changed unilaterally.
- **S-2/S-3/S-4 (LOW):** no helmet/security-header layer on the API
  (not browser-facing; rationale recorded), `postcss` advisories via
  `next@15.5.29` (already T-063 OPEN, build-time only), T-042 cap best-effort
  (already disclosed in THREATS.md).
- **S-5..S-8 (INFORMATIONAL):** best-effort `LOGIN_FAILED` audit row; money
  refusals in `transaction_attempts` (D-9, by design per AUDIT_COVERAGE.md);
  `USER_CREATED`-family events covered transitively; initiator display names
  exposed to entitled viewers only.

Verified strengths (evidence-based): argon2id OWASP parameters + timing
equalisation via a real DUMMY_HASH; opaque hashed-at-rest session tokens with
DB-side actor re-derivation; production cookie `Secure` enforced by boot-time
fail-fast; uniform 401/404 envelopes (no enumeration); in-transaction
role/grant re-reads (`FOR SHARE`) closing TOCTOU; last-admin + self-grant
guards; fully parameterised SQL everywhere (no string-interpolated user input
found); least-privilege runtime role with trigger-enforced append-only; strict
zod validation and 64 KiB body limit; fail-soft Redis limiter; pino secret
redaction; distinct `/health` vs `/ready`; frontend never touches the HttpOnly
cookie and never shows unknown money outcomes as confirmed refusals.

## 4. Financial integrity verification (full detail in FINANCIAL_INTEGRITY_EVIDENCE.md)

- **Live probes (this phase, read-only, local Docker DB, real accumulated
  history — 7,348 journal transactions, 850 customer accounts):**
  - Journal balance: **7,348 / 7,348 balanced** (0 unbalanced).
  - Stored vs ledger-derived balance: **0 mismatches**.
  - Event-counter integrity (count + Σseq identities): **0 mismatches**
    (after correcting a NULL-handling defect in the ad-hoc probe itself).
  - Global conservation: **customer_total 18,671,344 + clearing
    −18,671,344 = 0 exactly**.
- **Automated evidence:** 26-file/202-test API suite against real
  PostgreSQL+Redis (conservation, CON-001..004 races, IDEM-003/005/006,
  KEY_REUSED, timeout classification, audit atomicity) + executed mutation
  checks M1/M2/M3 from Phase 12.
- **Live seed determinism (this phase):** seed-demo re-run against a local
  API replayed both fixed-key movements (`replayed:true`), balances unchanged
  (200,884 / 50,250 paise; still 7 ledger rows) — exactly-once verified on
  real state.
- **Production posture:** 0 journals in production (no artificial financial
  data, by design); **production deposit journey remains
  `BLOCKED — awaiting owner-controlled real-admin bootstrap`** (intentional
  security decision, disclosed in every relevant document).

## 5. Automated test results (exact commands)

Environment for all API runs: Windows PowerShell, workdir `apps/api`; env
overrides built in-shell from the repo `.env` variable names (values never
printed) — `DATABASE_URL` → `postgresql://ledgerline_app:…@127.0.0.1:15432/balancevault`,
`DATABASE_URL_OWNER` → `ledgerline_owner@…15432`, `DATABASE_URL_BOOTSTRAP` →
`balancevault_bootstrap@…15432`, `REDIS_URL` → `redis://127.0.0.1:16379`.

| Check | Exact command | Result |
|---|---|---|
| API suite (unit+integration+api, real PG17+Redis) | `node --import tsx ..\..\node_modules\vitest\vitest.mjs run` (with the env overrides above) | **exit 0 — 26 files / 202 tests passed** (116.74s) |
| Web suite | `npm test` (workdir `apps/web`) | **exit 0 — 5 files / 48 tests passed** (1.19s) |
| TypeScript (both workspaces) | `npm run typecheck` (repo root: api then web `tsc --noEmit`) | **exit 0** |
| ESLint (both workspaces) | `npm run lint` | **exit 0** |
| Production frontend build | `npm run build -w apps/web` with `API_INTERNAL_URL=http://localhost:4000` | **exit 0** — 14 routes compiled |
| Migrations (idempotency/status) | `node apps\api\scripts\migrate.mjs` with `DATABASE_URL_OWNER` → Docker | **exit 0 — "No migrations to run!"**; `pgmigrations` shows 0001–0006 applied |

No tests were skipped. One ad-hoc SQL probe was corrected (NULL handling) and
re-run — recorded honestly in `FINANCIAL_INTEGRITY_EVIDENCE.md` §1. The two
dev-server shell processes from Phase 2 were lost to a session restart (no
code lost); all verification ran without them.

## 6. CI results

- Latest run at the Phase 3 baseline: **`43429125834` — success** on
  `66f2b29a…` (api job: lint+typecheck+bootstrap+migrate+test on real PG17/Redis
  services; web job: lint+typecheck+test+build).
- **Re-verified after the Phase 3 docs commits: run `43601656926` — success**
  on `c4593c53…` (head of the Phase 3 documentation commits, both jobs green).
  The final hash-recording edit after that run is docs-only; its own CI run on
  `main` can be confirmed with `gh run list --limit 1`.

## 7. Deployment verification (non-destructive production probes)

| Probe | Expected | Observed |
|---|---|---|
| `GET https://snovasis-assignment.onrender.com/health` | 200 `{ok:true}` | **200 `{ok:true}`** |
| `GET …/ready` | 200 with postgres+redis ok | **200 `{"ok":true,"checks":{"postgres":"ok","redis":"ok"}}`** |
| `GET …/me` (no cookie) | 401 uniform envelope | **401 `{"error":{"code":"UNAUTHENTICATED",…}}`** |
| `POST …/login` (bad creds, correct body) | 401 uniform envelope | **401 `{"error":{"code":"UNAUTHENTICATED","message":"Invalid email or password."}}`** |
| `GET https://snovasis-assignment-seven.vercel.app/` | redirect for unauthenticated users | **307** |
| `GET …/login` (frontend) | 200 | **200** |
| `GET …/api/me` (Vercel→Render proxy) | 401 uniform envelope | **401** |

Methodology notes (honesty):
- The first bad-credential login probe returned 400 — this was a **client-side
  artifact** (PowerShell 5.1 mangles inline JSON passed to curl.exe; the same
  artifact was recorded in the 2026-11-12 PROMPTS entry). With a correctly
  encoded body (temp file + `--data-binary`) the deployed API returns the
  uniform 401, matching the code (`auth.ts` uniform-refusal logic).
- Production cookie flags were **not** re-exercised with a live production
  login this phase (no production credentials are held in `.env`, correctly):
  the evidence stands on the Phase 1 production verification plus this phase's
  code-level re-verification of the config-checked `cookieSecure` path and the
  production boot succeeding (which the `COOKIE_SECURE=true` fail-fast rule
  requires).
- `/ready` vs `/health` distinction verified live (liveness vs dependency
  check) and by tests.

## 8. Documentation completed

Seven new Phase 3 deliverables (see §2) + targeted updates to `README.md`,
`WRITEUP.md`, `DEPLOYMENT.md`, `INTERVIEW_PREP.md`, and the dated `PROMPTS.md`
entry. Duplication was avoided by cross-linking (`INTERVIEW_PREPARATION.md` ↔
`INTERVIEW_PREP.md`; traceability ↔ `PROJECT_BRIEF.md`/`ACCEPTANCE.md`).

## 9. Remaining issues (honest list)

1. **Production deposit journey: `BLOCKED — awaiting owner-controlled
   real-admin bootstrap`.** Not silently marked verified anywhere.
2. **S-1** shared rate-limit buckets behind Render (MEDIUM) — owner decision
   recorded, not changed.
3. **T-063** postcss advisories via `next@15.5.29` (build-time only) — OPEN,
   owner decision.
4. **T-050** bootstrap operator identity is a claim, not proof — ACCEPTED
   residual.
5. Best-effort behaviours disclosed upstream: T-042 attempt cap; best-effort
   `LOGIN_FAILED` audit row (never suppresses the uniform 401).
6. No browser E2E suite — API 202 real-DB tests + web 48 unit tests; journeys
   verified manually through the real proxy.
7. Original challenge portal/spec not available in the repo and the portal
   has not been checked — traceability maps to `PROJECT_BRIEF.md` and this
   limitation is stated in `REQUIREMENT_TRACEABILITY.md`.
8. `npm run format:check` reports pre-existing files (prettier is not a CI gate).
9. PROMPTS.md has no dated entries for the 2026-11-13 Phase 1/2 sessions
   (disclosed in the Phase 3 entry rather than back-filled).

## 10. Human actions required

1. Verify the **challenge portal/submission process** (Gate 0 / H-1) — the
   project is not declared fully submission-ready until then.
2. Decide the **production real-admin bootstrap** timing (owner-only action;
   unblocks the production deposit journey).
3. Decide **S-1** (rate-limit topology) — options in SECURITY_REVIEW.md.
4. Confirm repository visibility timing (private until the placement cell
   clarifies).
5. Optionally review the disclosed OPEN/ACCEPTED threats in `THREATS.md`.

## 11. Final release recommendation

**CONDITIONAL GO.**

- The engineering acceptance gate is **met**: no unresolved CRITICAL/HIGH
  security findings; financial invariants have passing automated evidence and
  clean live probes; 202/202 + 48/48 tests pass; TypeScript/ESLint/builds/
  migrations/CI green; deployment health verified non-destructively; docs
  accurate and traceable; demo repeatable and deterministic; limitations
  disclosed honestly.
- The remaining conditions are all **owner actions**, not engineering work:
  the challenge-portal check (without it, "submission-ready" cannot honestly
  be declared), the production admin bootstrap decision (the deposit journey
  stays explicitly `BLOCKED` until then), and the S-1 topology decision.

## 12. Verification-level ledger (per the acceptance gate)

- **Verified in production (this phase):** `/health`, `/ready`, uniform-401
  auth surface (`/me`, bad-credential `/login`), Vercel→Render `/api/*`
  proxy, frontend redirect behaviour.
- **Verified locally (this phase):** financial invariant probes on real
  accumulated history; seed determinism/replay; migration idempotency;
  production build (with local API_INTERNAL_URL).
- **Verified through automated tests (this phase re-run):** 202 API tests +
  48 web tests (real PostgreSQL 17 + Redis 8, no mocks), typecheck, lint.
- **Verified in production (Phase 1/2 baseline, not re-claimed):** DB/Redis
  connectivity, migrations on Neon, registration→login journey, holder/
  auditor workflows, cookie security, withdrawal/transfer journeys (local DB).
- **Implemented — not independently verified (this phase):** none new.
- **Blocked pending human action:** production deposit journey (real-admin
  bootstrap); challenge-portal verification; S-1 decision.
