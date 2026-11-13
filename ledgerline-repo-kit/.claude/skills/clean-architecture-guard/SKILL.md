---
name: clean-architecture-guard
description: Review checklist for layer boundaries and engineering principles in LedgerLine diffs. Use before reporting any code task done.
---
# Architecture guard

Check every diff:
- `domain/` imports nothing from `http/`, `application/`, `infrastructure/`; no I/O, no `Date.now()`/random directly (inject clock/id).
- `http/` handlers only: validate (zod), authenticate, call one use case, serialise. No SQL, no business rules.
- `application/` orchestrates transactions and ports; no `req`/`res`.
- `infrastructure/` holds SQL (parameterised only); no policy decisions.
- Money: `BigInt`/`BIGINT`; no float; no `Number` sums.
- Errors: typed domain errors; one mapper to HTTP; no stack traces to clients; no secrets in logs.
- Frontend: no authoritative balance or permission logic; one API client; server components by default.
- Small functions, intention-revealing names, no dead code, no speculative abstractions, no new dependency without justification.
- Tests exist for every new rule; no test weakened.
Report violations as a list with file and line; fix before done.
