---
name: phase-runner
description: Execute one LedgerLine phase file safely: plan, get approval, implement small tasks, prove with real commands, report. Use whenever asked to run or continue a phase.
---
# Phase runner

1. Read `phases/PHASE-<nn>-*.md`, `CLAUDE.md`, `AGENTS.md` and the ADRs the phase cites. Confirm the previous gate has evidence; if not, stop and say so.
2. Post a short plan: tasks in order, files to touch, assumptions, risks, and any task needing human approval (schema, public API, security boundary, money semantics). Wait for approval on those.
3. Work **one task at a time**. Tests first where the behaviour is money or authorisation.
4. After each task run the relevant tests plus `assertGlobalInvariants`-based suites. Paste real output; never summarise as "passes".
5. Run the `clean-architecture-guard` checklist on the diff.
6. Report using `templates/PHASE_REPORT_TEMPLATE.md`: files changed, commands and results, threats whose evidence changed, open risks, suggested Conventional Commit message(s).
7. Draft a `PROMPTS.md` entry from what actually happened. Leave `TODO(human)` for what only the human knows (the commit link, what they personally caught). Never invent.
8. Stop at the gate. Do not start the next phase.
