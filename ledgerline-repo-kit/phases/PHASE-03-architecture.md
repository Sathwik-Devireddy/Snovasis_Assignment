# Phase 3: Architecture and ADRs

**Target:** Fri 6 Nov. **Agents:** 03 system architect, 04 database/ledger. **Skills:** clean-architecture-guard, ledger-posting, idempotent-money-command.

## Objective
Convert `docs/PROPOSED_DEFAULTS.md` into approved ADRs so implementation has no open money semantics.

## Tasks
- [ ] P3.1 ADR-001 stack and layering (D-1, D-2). **Needs human approval (H-3).**
- [ ] P3.2 ADR-002 ledger model, sign convention, clearing account (D-4, D-5, D-6).
- [ ] P3.3 ADR-003 concurrency and isolation: lock order, retries, timeouts (D-7).
- [ ] P3.4 ADR-004 idempotency and refusal recording (D-8, D-9). Include the sequence diagram as text.
- [ ] P3.5 ADR-005 append-only enforcement and DB roles (D-10) incl. accepted residual risk.
- [ ] P3.6 ADR-006 authentication and sessions (D-11).
- [ ] P3.6b ADR-007 permission revocation versus in-flight operations (D-13): `FOR SHARE` on grants inside the money transaction, global lock order, "operation that already authorised may finish".
- [ ] P3.7 Draft the schema as SQL in `docs/schema-draft.sql` (not a migration yet) with every CHECK, UNIQUE, FK and trigger named.
- [ ] P3.8 Sequence descriptions for deposit, withdraw, transfer, each naming where authN/authZ, key claim, lock, balance check, write and commit happen.
- [ ] P3.9 Failure-mode table: what happens if the process dies at each step.

## Allowed files
`docs/adr/**`, `docs/schema-draft.sql`, `docs/ARCHITECTURE.md`. Use `templates/ADR_TEMPLATE.md`.

## Acceptance (Gate 3)
ADRs marked Accepted by the human. The human can explain ADR-003 and ADR-004 aloud without notes (practice with `docs/INTERVIEW_PREP.md`).

## Closeout
One commit per ADR is ideal. Suggested: `docs(adr): accept ledger model and concurrency strategy`.
