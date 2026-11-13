# Agent Contract — LedgerLine

## Mission

Build and verify LedgerLine: a small, understandable financial ledger application in which money is conserved, duplicate requests do not move money twice, concurrent operations cannot overspend accounts, and every successful or refused attempt can be explained from durable records.

## Source of truth and priority

1. The official Snovasys LedgerLine problem statement and event instructions.
2. The repository's accepted architecture decisions and approved product requirements.
3. This engineering pack.
4. An agent's recommendations.

If two instructions conflict, stop, identify the conflict and ask the human owner. Do not silently choose the convenient interpretation. In particular, the challenge email says the repository must not be public before the deadline, while the deliverables list asks for a public repository. Keep it private until the placement cell clarifies the timing.

## Non-negotiable engineering principles

- Correctness before convenience; correctness before visual polish.
- Server and database enforce financial rules. Frontend validation is usability only.
- Use integer minor units (for example, paise) for money. Never use binary floating-point for monetary values.
- Every internal transfer must be represented by balanced ledger postings in one database transaction.
- Use a documented, tested concurrency strategy. A read-then-write check without a lock or equivalent atomic conditional update is not sufficient.
- Idempotency must be enforced by a database uniqueness constraint and transaction-safe handling, not by disabling a button.
- The same idempotency key with a different payload must be rejected.
- Ledger records are append-only for the application runtime. Corrections use compensating entries; never edit or delete historical postings through normal application paths.
- Authorization is checked server-side for every account-specific operation.
- Record refused attempts as required by the product's statement/audit design without leaking confidential account data.
- Never log passwords, JWTs, secrets, full payment credentials or sensitive tokens.
- AI may assist with review or anomaly suggestions; it must never autonomously authorize or execute money movement.

## Agent operating protocol

Every assignment must state: phase, objective, allowed files, prohibited changes, dependencies, acceptance criteria and evidence expected.

Before implementation:
1. Inspect the current repository and relevant tests.
2. Summarize the existing behavior and constraints.
3. Identify assumptions and risks.
4. Propose the smallest safe change.
5. Wait for human approval when the task changes schema, public API, security boundaries, architecture, deployment, or money semantics.

During implementation:
- Work only within the assigned scope.
- Prefer small, reviewable changes.
- Follow existing naming, formatting and project conventions.
- Add or update tests with each behavior change.
- Do not weaken or delete a failing test to make a task pass.
- Do not add a dependency without explaining why it is needed.
- Do not add unrequested features, microservices, queues or infrastructure.
- Do not modify the official submission portal or probe Snovasys systems.

After implementation:
- List every file changed and why.
- State exact commands run and their real outcomes.
- Include test output or clearly say tests were not run.
- Identify unresolved risks and follow-up tasks.
- Suggest a conventional commit message; the human performs the commit.
- Add an honest dated `PROMPTS.md` entry when AI output was used and materially reviewed/corrected.
- Update `THREATS.md` only when implementation and evidence justify a status change.

## No-code discovery rule

The initial repository audit is read-only. Do not create components, migrate folders, rewrite layouts, reformat files or alter dependencies during discovery. Return findings and prioritized recommendations first.

## Git and integrity rules

- Use real commits as work is completed; never fabricate timestamps, authorship, activity or history.
- Do not share the repository, code or account with another candidate.
- Keep the repository private before the deadline unless written clarification says otherwise.
- Do not commit `.env`, credentials, database dumps containing secrets, private keys or personal data.
- Never claim a feature, deployment, test or security mitigation that has not been verified.

## Definition of done for an agent task

A task is done only when the acceptance criteria are met, relevant tests are added and run, the diff is reviewable, documentation is consistent, and known limitations are recorded. “Code generated” is not “done”.
