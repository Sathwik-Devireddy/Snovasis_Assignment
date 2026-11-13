# Review of `LedgerLine_Agent_Pack.zip`

## Verdict

**Yes, you can use it, as an instruction layer, not as a codebase.** It builds nothing by itself.

## What was checked

| Check | Result |
|---|---|
| Contents | 24 Markdown files (+3 folders): 11 root docs, 11 agent prompts, 2 templates |
| Executable content | None. No `.sh`, `.js`, `.py`, `package.json`, binaries |
| Dependencies | None to install. There is no manifest, so nothing to resolve or audit |
| Embedded instructions aimed at the tool (injection patterns, `curl`, `eval`, `base64`, `rm -rf`) | None found |
| Internal consistency | File references in README/INDEX match the files present |
| Consistency with the official brief | Matches the ten requirements, the three roles, THREATS/PROMPTS expectations and the "attack it" scenario |

The pack's strengths: financial correctness is ranked above polish, evidence is required before a status changes, "exactly once" is correctly qualified, a mutation check is required, and the public-repo conflict is flagged.

## Gaps found, and what this kit does about them

| # | Gap in the pack | Why it matters | Handled in |
|---|---|---|---|
| G1 | No skills, no per-phase executable prompts, no slash commands; only role descriptions | You asked for phases, skills and agent files an agent can run | `phases/`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/` |
| G2 | Assumes an **existing repository** to audit; the frontend audit is "Phase 1, read-only" | There is nothing to audit on day 1 | Phase 1 is now greenfield discovery; the frontend audit runs at the Phase 11 gate |
| G3 | Baseline stack is Flask; your profile is TypeScript/Next.js/PostgreSQL | You must change code live in the interview | `PROPOSED_DEFAULTS.md` D-1 (override allowed) |
| G4 | Refused attempts written inside a transaction that then rolls back are **lost** | Requirement 8 and the audit marks | D-9, T-021 |
| G5 | Idempotency comes after deposits, withdrawals and transfers (Phase 9) | Retrofitting changes transaction boundaries and invites double-effect bugs | `moneyCommandRunner` is built in Phase 7; Phase 9 hardens and attacks it |
| G6 | Clearing account for deposits/withdrawals not analysed | A locked clearing row serialises every external movement | D-5, T-022 |
| G7 | No mention that `pg` returns BIGINT as a string, or JSON number limits | Silent precision loss in a money system | D-4, T-023 |
| G8 | Append-only via "DB role" with no note on managed hosts, TRUNCATE, or owner bypass | Typical hosted databases hand you one owner role | D-10, T-026, Phase 4 task |
| G9 | Who may deposit is left open; admin insider risk not discussed | Judges try to move money they should not | D-3, T-024, T-025 |
| G10 | No "deploy early" task | The brief warns most candidates never deploy | Phase 4 deploys a walking skeleton |
| G11 | The pack says the event page *also* requires two authorisation/audit entries in PROMPTS.md | The portal pages are behind login and I could not read them | Treated as the stricter rule; satisfying it costs nothing. Re-check on the portal |
| G12 | No interview preparation | Shortlisted candidates explain and change code live | `docs/INTERVIEW_PREP.md` |

## Deliberate deviations from the pack

1. Phase order: idempotency runner starts in Phase 7 (G5).
2. Frontend audit moved from Phase 1 to the Phase 11 gate (G2).
3. Stack default changed to TypeScript end to end (G3).
4. Added threats T-021 to T-040 to `THREATS.md`; all start `OPEN`.

Everything else (agent rules, quality gates, test IDs, templates) is kept verbatim from the pack.

## Kit self-review fixes (round 2)

| Issue | Fix |
|---|---|
| ARCHITECTURE.md still said Flask | Diagram now says Fastify; `verify-kit.sh` fails on stale Flask/SQLAlchemy text |
| `accounts.balance_minor >= 0` clashed with the derived clearing account | `kind` CUSTOMER/SYSTEM with a conditional CHECK; system balances are ledger-derived (D-6, DATA_MODEL, Phase 6) |
| Authorisation refusals vs "authorise before writes" | Authorisation moved inside the transaction; refusal rolls back, then a separate short audit transaction records it (D-8, D-9) |
| `sessions` and `audit_events` missing from DATA_MODEL | Added, with append-only rules |
| `frontend-design` skill referenced but absent | Skill created; verifier now checks skills, names, threat IDs |
| Phase 8 mutation claim | Split into A (remove lock → CON-001 fails) and B (reverse order → deadlock test fails) |
| Revocation racing an in-flight transfer | D-13 / ADR-007: grants read `FOR SHARE` in the money transaction, revocation waits, global lock order; T-041, AUTH-008 |
