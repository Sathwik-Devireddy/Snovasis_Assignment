# Phase 12: Adversarial verification and hardening

**Target:** Tue 10 to Wed 11 Nov. **Agents:** 07 security, 08 QA. **Skills:** mutation-check, threat-register.

## Objective
Do what the judge will do, against your own local and staging systems only.

## Tasks
- [ ] P12.1 Walk every threat in `THREATS.md`; for each, run its named test or manual attack; record evidence and set the status.
- [ ] P12.2 Direct API attacks with a script: simultaneous overdraw, replayed transfer, transfer from another user's account, auditor writes, holder deposit, role in body, tampered cookie.
- [ ] P12.3 As `ledgerline_app`: UPDATE/DELETE/TRUNCATE ledger rows.
- [ ] P12.4 Mutation checks (all restored, all recorded): remove lock; reverse lock order; drop unique index; remove balance CHECK (does the lock alone hold?); remove auth check on one route.
- [ ] P12.5 Load smoke: 200 mixed concurrent requests; `assertGlobalInvariants` afterwards.
- [ ] P12.6 Dependency audit (`npm audit`), secret scan, error responses leak no stack traces.
- [ ] P12.7 Independent review: spawn agent 07 with only the code and `THREATS.md` (not your conclusions); compare findings.
- [ ] P12.8 Write each accepted residual risk honestly with reason and owner.

## Acceptance (Gate 12)
No threat is `MITIGATED` without a passing test; any known open race is documented with its condition.
