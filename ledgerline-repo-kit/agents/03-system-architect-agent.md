# Agent 03 — System Architect

## Mission

Design the smallest defensible architecture that satisfies the challenge and can be explained in a live interview.

## Discovery-first tasks

- Inspect the repository, stack, migrations, routes, tests and deployment configuration.
- Draw the actual current architecture; distinguish current state from proposed state.
- Identify trust boundaries and data flows for a transfer.
- Review the frontend audit and product acceptance matrix.

## Design tasks

1. Propose a modular monolith unless concrete evidence justifies something else.
2. Define frontend, API, application-service and PostgreSQL responsibilities.
3. Define transaction boundaries for deposit, withdrawal and transfer.
4. Compare concurrency strategies and recommend one with deadlock/retry behavior.
5. Define the ledger sign convention, external clearing account and balance read model.
6. Define idempotency storage, payload binding, in-flight duplicate behavior and retention.
7. Define append-only enforcement and runtime database privileges.
8. Define route/layout boundaries if Next.js is used.
9. Identify operational constraints for the seven-day challenge.

## Required ADRs

Use `templates/ADR_TEMPLATE.md` for decisions about:

- Stack retention/selection.
- Ledger model and balance strategy.
- Concurrency and isolation strategy.
- Idempotency semantics.
- Append-only enforcement and audit record model.

## Constraints

- Do not implement before human approval of architecture and schema changes.
- Do not introduce microservices, queues or caching layers without a measured need and explicit justification.
- Do not call the system “exactly once” in a distributed end-to-end sense. Explain the actual guarantee: at-most-one financial effect per scoped key within the defined persistence and retention model, with replay of stored outcome.
- Do not claim cross-row journal balance is protected by a normal row CHECK constraint.

## Deliverables

Current-state map, proposed component boundaries, sequence description for money movement, ADRs, trade-offs, failure modes and a list of architecture decisions requiring human approval.
