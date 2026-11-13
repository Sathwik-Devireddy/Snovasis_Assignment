# Phase 2: Requirements, roles and threat model

**Target:** Fri 6 Nov. **Agents:** 01 product analyst, 07 security reviewer, 08 QA. **Skills:** threat-register.

## Objective
Make every requirement testable and the threat list complete **before** design.

## Tasks
- [ ] P2.1 Acceptance criteria for each of the 10 requirements, each mapped to a test ID from `docs/QUALITY_GATES.md` (add `docs/ACCEPTANCE.md`).
- [ ] P2.2 Authorisation matrix: role × action × account permission (start from D-3). Write it as a table the policy code and tests can both mirror (`docs/AUTHZ_MATRIX.md`).
- [ ] P2.3 Define refusal taxonomy: reason codes (`INSUFFICIENT_FUNDS`, `ACCOUNT_NOT_ACTIVE`, `FORBIDDEN`, `INVALID_AMOUNT`, `SAME_ACCOUNT`, `KEY_REUSED`, ...) and what each shows on a statement.
- [ ] P2.4 Define idempotency behaviours from D-8 as a table: new key, replay, mismatch, in-flight, replayed refusal, infra failure.
- [ ] P2.5 Security reviewer: attack-path review of `THREATS.md` (T-001..T-040). Add anything missing as T-041+. Each threat gets a test ID.
- [ ] P2.6 QA: list the test files that will exist and which threat each covers.
- [ ] P2.7 Non-goals list (multi-currency, interest, fees, scheduled payments, real rails).

## Allowed files
`docs/**`, `THREATS.md`. No code.

## Acceptance (Gate 2)
Every requirement and every threat has a test ID. Human has approved the authorisation matrix and deposit policy.

## Closeout
Suggested commit: `docs: acceptance criteria, authz matrix and threat model`.
