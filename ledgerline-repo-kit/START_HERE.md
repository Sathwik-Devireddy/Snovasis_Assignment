# START HERE: LedgerLine build kit

Rename or delete this file once your real `README.md` exists (Phase 13).

## What you have

A planning-and-instruction layer that lets an AI coding agent (Claude Code) build LedgerLine in verified phases while you stay in control and keep an honest history, which is what the evaluators read.

## Set up (10 minutes)

```bash
mkdir ledgerline && cd ledgerline
# copy the contents of this kit into the folder, then:
git init
git add . && git commit -m "chore: add engineering kit (phases, skills, agents, docs)"
# create a PRIVATE GitHub repo and push. Keep it private until the placement cell confirms.
claude            # start Claude Code in this folder
```

Then in Claude Code: `/phase 1`.

## Schedule (IST). Today is Friday 6 Nov; deadline Thursday 12 Nov, 18:00

| Day | Phases | Exit evidence |
|---|---|---|
| Fri 6 | 0, 1, 2, 3, start 4 | Portal done; repo private; ADRs approved; threat register reviewed |
| Sat 7 | 4 (incl. **deployed walking skeleton**), 5, 6 | Clean-clone setup works; login + roles tested; schema + append-only tested |
| Sun 8 | 7, 8 | Deposit/withdraw/transfer + real race tests |
| Mon 9 | 9, 10 | Idempotency proven in stored data; statements + reconciliation |
| Tue 10 | 11, 12 | UI flows; adversarial pass; mutation check |
| Wed 11 | 13 | Live deploy hardened; docs; demo recorded |
| Thu 12 | 14 | Submit by 15:00 at the latest; stop edits well before 18:00 |

Phases 0 and 14 are yours; the rest are agent phases with human gates.

## The rules that cost you the job if broken

- Commit as you go; real history only. Never fake it.
- Never share code with another candidate. Two similar submissions both get rejected.
- Repository stays private until the placement cell confirms timing (email vs hand-in conflict).
- Write `PROMPTS.md` as you go: five dated entries minimum, at least two about money integrity/concurrency/idempotency (and, to be safe, two about authorisation/audit). Each one needs a real error the AI made, how you caught it, and the commit that fixed it.
- You must be able to explain every line. Use `docs/INTERVIEW_PREP.md` after each phase.

## Phase index

| # | File | Owner |
|---|---|---|
| 0 | `phases/PHASE-00-readiness.md` | You |
| 1 | `phases/PHASE-01-discovery.md` | Agents 00, 01 |
| 2 | `phases/PHASE-02-requirements-threats.md` | Agents 01, 07, 08 |
| 3 | `phases/PHASE-03-architecture.md` | Agent 03, 04 |
| 4 | `phases/PHASE-04-foundation-deploy.md` | Agents 05, 09 |
| 5 | `phases/PHASE-05-identity-authorization.md` | Agents 05, 07 |
| 6 | `phases/PHASE-06-schema-ledger-core.md` | Agents 04, 05 |
| 7 | `phases/PHASE-07-deposits-withdrawals.md` | Agents 05, 08 |
| 8 | `phases/PHASE-08-transfers-concurrency.md` | Agents 05, 04, 08 |
| 9 | `phases/PHASE-09-idempotency.md` | Agents 05, 08 |
| 10 | `phases/PHASE-10-statements-audit-reconciliation.md` | Agents 05, 07 |
| 11 | `phases/PHASE-11-frontend.md` | Agents 02, 06 |
| 12 | `phases/PHASE-12-adversarial-hardening.md` | Agents 07, 08 |
| 13 | `phases/PHASE-13-release-docs-demo.md` | Agents 09, 10 |
| 14 | `phases/PHASE-14-submission-freeze.md` | You |
| 15 | `phases/PHASE-15-optional-extras.md` | Only if Gate 12 passed |

Read `docs/PACK_REVIEW.md` for what was verified in the original zip and what changed.
