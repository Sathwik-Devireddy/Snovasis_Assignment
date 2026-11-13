# Phase 13: Release, documentation and demo

**Target:** Wed 11 Nov. **Agents:** 09 devops, 10 documentation. **Skills:** api-doc-sync.

## Tasks
- [ ] P13.1 Production deploy: run migrations deliberately; create `ledgerline_app` with a strong secret; app connects as that role only.
- [ ] P13.2 Seed one demo user per role with synthetic data; passwords documented as demo-only; rotate anything accidental.
- [ ] P13.3 HTTPS, cookies, CORS/origin, health checks verified from outside your session.
- [ ] P13.4 README: purpose, architecture, setup from clean clone, seed credentials, live URL, commands, limitations.
- [ ] P13.5 `docs/API.md`: per endpoint role, permission, request/response, idempotency, transaction boundary, ledger effect, refusal behaviour, test IDs.
- [ ] P13.6 Write-up: what was built and omitted, integrity and concurrency model in your own words, AI use and errors, unfinished work.
- [ ] P13.7 Record the five-minute demo per agent 10's outline using the real deployment.
- [ ] P13.8 Live smoke test in a private window on another device and network.
- [ ] P13.9 Final `THREATS.md` and `PROMPTS.md` review: at least five dated entries, real commit links.

## Acceptance (Gate 13)
A stranger can run it from a clean clone and open the live app with the README credentials.
