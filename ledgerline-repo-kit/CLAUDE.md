# LedgerLine: instructions for Claude Code

@AGENTS.md

## What this repository is

A greenfield build of **LedgerLine** for the Snovasys hiring challenge (deadline 12 Nov 2026, 18:00 IST). Financial correctness outranks features and polish. The marks are dominated by what a judge can break: overdraw, double-spend, moving another user's money, tampering with the ledger.

## How to work here

1. Work **one phase at a time** from `phases/`. Start with `/phase <n>` or read `phases/PHASE-<nn>-*.md` and follow the `phase-runner` skill.
2. Before writing code: summarise the phase, list the files you will touch, state assumptions, and **wait for approval** if the task changes schema, public API, security boundaries, architecture or money semantics.
3. Defaults live in `docs/PROPOSED_DEFAULTS.md`. Do not contradict an accepted ADR in `docs/adr/`.
4. Money code must follow the skills `ledger-posting`, `idempotent-money-command` and `concurrency-test-writing`.
5. Run `clean-architecture-guard` on every diff before reporting a task done.
6. Finish every task with: files changed, **real** commands run and **real** output, open risks, a suggested Conventional Commit message. The human commits.
7. Never write a `PROMPTS.md` entry for the human. Draft it from what actually happened and mark the fields only the human can fill (`TODO(human)`). Never invent a commit link.
8. Never mark a threat `MITIGATED` without a passing, named test.

## Architecture rules (enforced in review)

- Layers: `http → application → domain`; `infrastructure` implements ports. `domain/` has no I/O and imports nothing from other layers.
- No business rule in a route handler or React component.
- Money is `BIGINT` minor units; `BigInt` in code; never `float`/`Number` for sums.
- Parameterised SQL only. One transaction per money command. Never continue after a failed statement inside a transaction.
- Typed domain errors, mapped to HTTP once, at the edge.
- No new dependency without a one-line justification in the report.

## Commands (fill in at Phase 4, keep accurate)

```
npm run db:up          # start local PostgreSQL
npm run db:migrate     # apply migrations
npm run db:seed        # demo-only data
npm test               # unit + integration + concurrency + api (needs PostgreSQL)
npm run lint && npm run typecheck
```

## Not allowed

Probing Snovasys systems or another candidate's deployment; committing secrets; making the repository public before the placement cell confirms timing; weakening or deleting a failing test to go green; running destructive tests against the live demo.

## Where things are

`docs/` design and policy · `phases/` ordered work · `agents/` role prompts · `.claude/agents/` subagent wrappers · `.claude/skills/` reusable procedures · `templates/` ADR and phase report · `THREATS.md` / `PROMPTS.md` are graded deliverables.
