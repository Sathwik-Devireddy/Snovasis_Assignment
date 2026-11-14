# Submission Checklist — Phase 3

*Date: 2026-11-14 · Prepared at `main` @ `66f2b29` (Phase 3 commit to follow)*

Tick meaning: **[x]** verified this phase · **[ ]** open — owner action.

## 1. Before you submit (human actions)

- [ ] **Verify the challenge portal/submission process** — the original
      Snovasys portal has **not** been checked in Phase 3 (no credentials,
      no portal access). Until this is done, do **not** declare the project
      "fully submission-ready".
- [ ] Reconcile the original portal wording with
      [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) — the matrix in
      [`REQUIREMENT_TRACEABILITY.md`](REQUIREMENT_TRACEABILITY.md) maps to the
      in-repo approved brief, not to a reconstructed original.
- [ ] **Repository visibility** — confirm the repo is PRIVATE until the
      placement cell clarifies timing (H-1); `gh repo view` last verified
      PRIVATE on 2026-11-09 — re-check before making it public.
- [ ] **Production real-admin bootstrap** (owner-only, at a time you choose):
      `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` +
      `apps/api/scripts/bootstrap.mjs` against the production env. This
      unblocks the production deposit journey (currently documented as
      `BLOCKED — awaiting owner-controlled real-admin bootstrap`).
- [ ] Owner decision on **S-1** (shared rate-limit buckets behind Render) —
      options in [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) §S-1.
- [ ] Rotate the demo-only passwords before any real deployment (they are
      published as demo-only placeholders in this repo).

## 2. Package contents (all verified present)

| Item | Location | Status |
|---|---|---|
| Project overview / write-up | `README.md`, [`WRITEUP.md`](WRITEUP.md) | [x] |
| Architecture + ADRs | [`ARCHITECTURE.md`](ARCHITECTURE.md), `docs/adr/ADR-001..007` | [x] |
| API documentation | `API.md`, `API_CONTRACT.md` | [x] |
| Security documentation | [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md), `AUTHZ_MATRIX.md`, `REFUSAL_CODES.md`, `AUDIT_COVERAGE.md`, `THREATS.md` | [x] |
| Financial integrity evidence | [`FINANCIAL_INTEGRITY_EVIDENCE.md`](FINANCIAL_INTEGRITY_EVIDENCE.md) | [x] |
| Requirement traceability | [`REQUIREMENT_TRACEABILITY.md`](REQUIREMENT_TRACEABILITY.md) | [x] |
| Test evidence | [`PHASE_3_FINAL_REPORT.md`](PHASE_3_FINAL_REPORT.md) §Test results; `TEST_PLAN.md`; `ACCEPTANCE.md` | [x] |
| Deployment runbook | [`DEPLOYMENT.md`](DEPLOYMENT.md) | [x] |
| Demo instructions | [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) | [x] |
| Interview preparation | [`INTERVIEW_PREPARATION.md`](INTERVIEW_PREPARATION.md), `INTERVIEW_PREP.md` | [x] |
| Honest limitations | `WRITEUP.md` §unfinished; README "Known limitations"; final report §Remaining issues | [x] |
| Dated AI-use record | `../PROMPTS.md` (Phase 3 entry added; gap for 2026-11-13 sessions disclosed there) | [x] |
| Threat register | `THREATS.md` rev 3 (OPEN/ACCEPTED rows with reasons) | [x] |
| Known-issues disclosure | production deposit BLOCKED note (README, runbook, traceability, final report) | [x] |

## 3. Quality gates (verified this phase)

- [x] No unresolved CRITICAL security findings.
- [x] No unresolved HIGH security findings.
- [x] Financial invariants: passing automated evidence + live probes
      (`FINANCIAL_INTEGRITY_EVIDENCE.md`).
- [x] API tests: 26 files / 202 tests pass (real PostgreSQL 17 + Redis 8).
- [x] Web tests: 5 files / 48 tests pass.
- [x] TypeScript (`tsc --noEmit`) both workspaces: pass.
- [x] ESLint both workspaces: pass.
- [x] Production Next.js build (14 routes): pass.
- [x] Migrations: 6/6 applied; idempotent re-run verified.
- [x] CI: green on the Phase 3 baseline (`43429125834`); re-verify after the
      Phase 3 docs commit.
- [x] Deployment health: `/health` 200, `/ready` 200 (postgres+redis ok),
      uniform-401 auth surface, Vercel→Render proxy — all re-probed
      non-destructively this phase.
- [x] Local demo: seed determinism verified live (replay, no double-posting).

## 4. Pre-commit checks for the Phase 3 docs commit

- [ ] `git status` — confirm only Phase 3-owned files are staged; the human's
      uncommitted Neon tooling (`.gitignore`, `package.json`,
      `package-lock.json`, `neon.ts`, `.neon/`) and untracked logs/dumps stay
      **unstaged**.
- [ ] No secrets in the diff (grep for password/token/conn-string patterns).
- [ ] `npm run lint` and `npm run typecheck` still exit 0 (docs-only change,
      but cheap to confirm).
- [ ] Push and confirm CI green.

## 5. Final declaration rule

The project may be declared **submission-ready** only when: items 1.1–1.4 are
done (portal check, brief reconciliation, visibility confirmation, and either
the owner bootstrap or an explicit decision to ship with the BLOCKED
disclosure), and the Phase 3 docs commit is green on CI. Until the portal has
been checked, the honest status is: **engineering complete and verified;
submission process unverified.**
