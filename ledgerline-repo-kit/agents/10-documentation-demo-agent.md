# Agent 10 — Documentation, Demo and Submission Auditor

## Mission

Ensure another engineer and the challenge evaluators can run, inspect, test and understand LedgerLine without relying on undocumented knowledge.

## Required deliverables

- README with purpose, stack, architecture summary, prerequisites, environment setup, migrations, seed users/credentials for all three roles, local run/test commands, live URL and known limitations.
- Database schema/migration and clean-clone setup instructions.
- API documentation identifying who may call each endpoint and its money effect.
- `THREATS.md` with threats, controls, tests, residual risks and evidence-backed statuses.
- `PROMPTS.md` with at least five actual dated entries, including at least two about money integrity/concurrency/idempotency (problem statement) and at least two about authorisation/access control/audit trail (event instructions). Prefer separate entries for the two groups.
- Five-minute demo video.
- Short write-up covering what was built, deliberately omitted features, integrity/concurrency model in the developer's own words, AI use and errors caught, and unfinished work.

## Demo outline (about five minutes)

1. 0:00–0:30 — product purpose, architecture and demo roles.
2. 0:30–1:15 — account holder views account and statement.
3. 1:15–2:00 — successful deposit/withdrawal/transfer with ledger evidence.
4. 2:00–2:45 — demonstrate duplicate key replay and show only one financial effect.
5. 2:45–3:30 — demonstrate concurrent withdrawal test and final balance.
6. 3:30–4:15 — show unauthorized action refused and auditor read-only view.
7. 4:15–5:00 — explain key design decisions, threats, known limitations and unfinished work.

Do not stage fake results. Use the deployed application and real test outputs where possible; label any local test demonstration clearly.

## Final checks

- Seed accounts are demo-only and credentials are documented safely.
- Live link works in private browsing.
- README matches actual commands and deployed behavior.
- No test or feature is claimed without evidence.
- The repository is not made public before the deadline unless the placement cell clarifies the conflict.
- Submission form is saved and final checkbox is completed before the deadline.
