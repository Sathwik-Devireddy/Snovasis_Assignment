# ADR-001: Stack and layering (D-1, D-2)

- **Status:** Proposed — awaiting Gate 3 human acceptance (stack content approved as H-3, 2026-11-06, recorded verbatim in `docs/DISCOVERY.md` §5)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.1, `phases/PHASE-03-architecture.md`)

## Context

The workspace (`Snovasis/`) is greenfield: the Phase 1 audit verified there is no existing application code, no `package.json`, no git history — only this engineering kit (`docs/reports/PHASE-01-report.md`, `docs/DISCOVERY.md` §1). There is therefore no existing stack to preserve; the decision is free but the marking criteria ("money behaves correctly", "evidence is real", "the candidate can defend it live") demand a stack the human can modify, debug and explain under interview pressure, and a database layer where locks, transactions and constraints stay visible rather than being hidden behind an ORM.

Local tooling verified in Phase 1: Node v22.15.1, npm 11.6.2, Git 2.50.1 (Windows), PostgreSQL 17.10 on PATH; Docker availability unverified (Phase 4 item, H-4).

## Decision drivers

- Correctness and security (money path must be explicit and testable against real PostgreSQL).
- Explainability in the interview — one language, one transaction model the human can walk through.
- Time to implement and verify within the challenge window (6–12 Nov).
- Operational simplicity — one command from a clean clone.
- No special infrastructure (AGENTS.md: no unrequested microservices/queues/infrastructure).

## Options considered

1. **Approved stack (chosen): Node.js 22 + TypeScript monorepo — Fastify + zod API, raw SQL via `pg` (no ORM), Next.js (App Router) presentation-only frontend, `node-pg-migrate`, Vitest (unit/integration/concurrency/api) + Playwright smoke, docker-compose PostgreSQL, GitHub Actions with a Postgres service container.**
   - Advantages: one language end to end; `pg` keeps lock/transaction/constraint mechanics first-class for the money path; the human's strongest stack (H-3 rationale).
   - Disadvantages: TS setup cost; manual SQL Discipline required (parameterised queries only).
   - Failure modes mitigated by other ADRs: SQL misuse → ADR-002/ADR-005 layering + roles; drift between cached and ledger balances → ADR-002 reconciliation tests.
2. **Pack's original Flask/Python baseline.** The kit intentionally deviates — `docs/PROPOSED_DEFAULTS.md` D-1 records why, and DISCOVERY §5 shows the human accepted the deviation at H-3. Disadvantage if chosen: double language (Python API + TS/Next frontend), weaker fit with the human's stated strengths.
3. **NestJS/Prisma or an ORM-heavy stack.** Prisma abstracts exactly the lock/transaction/trigger behaviour ADR-003..ADR-005 must make visible and testable. Rejected.

## Decision

Adopt option 1 exactly as tabulated in `docs/PROPOSED_DEFAULTS.md` D-1, with the D-2 layering:

```
apps/api/src/
  http/             routes, zod schemas, auth plugin, error mapper   (thin; no business rules)
  application/      use cases + moneyCommandRunner (transaction + idempotency + attempt recording)
  domain/           pure code, no I/O: Money, journal builder, permission policy, request hashing
  infrastructure/   pg pool, tx runner, SQL repositories, password hasher, clock, id generator
  config/           env parsing and validation
apps/web/           Next.js UI (presentation only)
db/migrations/      versioned SQL
apps/api/test/{unit,integration,concurrency,api}/
```

Dependency rule: `http → application → domain`; `infrastructure` implements what `application` needs; `domain` imports nothing from the other layers. An interface is introduced **only** where a second implementation or test double is genuinely needed (clock, id generator, transaction runner). No business rules in handlers or UI; every money/sequence value crosses textual boundaries as a JSON **string** (ADR-002); SQL is parameterised only.

Data-access stacks (BalanceVault expansion, human decision 2026-11-09 — additive, does not supersede any approved financial decision): (1) **Prisma Client** for typed *routine* database access — sessions, users, accounts/grants administration reads/writes, audit-event reads, statement pagination — always in its own transaction and never for a financial operation; (2) **raw `pg` client** for *all* financial operations, unchanged, because they require explicit PostgreSQL row locks (`FOR SHARE`/`FOR UPDATE`), measured balances, event-sequence allocation and multi-statement transaction semantics an ORM layer must not abstract; (3) **Redis** is an edge rate-limiting cache only — it is never an authority for money, ledger, idempotency or audit state. Both access paths may use separate pooled connections but must never split one financial operation across independent transactions (single transaction owner rule: `ADR-005`). Migrations remain owned by **node-pg-migrate**; Prisma's schema is generated to mirror the migrated database and its migration engine is not used (no second migration authority).

Hosting constraint (H-4, Phase 4): the chosen host must permit a **second, non-owner database role** (`ledgerline_app` of ADR-005); this is verified before the Phase 4 deployment step (P4.8) — not before Phase 4 code begins — per the human's recorded decision (`docs/DISCOVERY.md` §5b, 2026-11-08), which supersedes this ADR's earlier "before Phase 4 code" timing wording. Local PostgreSQL 17.10 is the development fallback / docker-compose target (the human's chosen Phase 4 dev-DB pattern).

## Consequences

### Positive
- Money-path mechanics (row locks, deferred constraint triggers, role grants) remain directly readable SQL — each is testable with the kit's test plan.
- CI from scratch (service container) protects the "evidence is real" criterion: tests that ran are provably runnable from a clean clone.
- Frontend stays presentation-only (matches `docs/ARCHITECTURE.md` responsibilities and ADR-006's single-origin design).

### Negative / trade-offs
- **Raw-SQL-only rule (superseded for routine queries only — BalanceVault expansion, human decision 2026-11-09):** the original v1 position was "no ORM anywhere"; the expanded challenge mandates **Prisma Client for typed routine database access**. The money path is unchanged: ALL financial operations (locks, balance checks, ledger posts, idempotency claims, refusal audit) remain hand-written, parameterised raw SQL inside a single explicit transaction — no financial query is delegated to ORM convenience, and no ORM safety net replaces review discipline there. See `ADR-005` ("Data-access transaction strategy") for the connection/transaction boundary rules.
- Two apps (API + web) share a monorepo — modest tooling overhead, accepted for single-language coherence.
- Expanded stack gains **Prisma** (routine typed access) and **Redis** (API rate limiting only) — new operational surfaces (T-060/T-062); both are bounded: Redis never holds financial state, Prisma never executes money-path statements (`phases/PHASE-04-foundation-deploy.md`, BalanceVault additions).

### Risks and mitigations
- *Risk:* Docker unavailable during Phase 4 → blocked CI/local parity. *Mitigation:* Phase 1 verified a local PostgreSQL 17.10; ADR-005's second-role test can run against it; H-4 explicitly defers hosting verification to before the Phase 4 deployment step (P4.8; `docs/DISCOVERY.md` §5b) with a fallback.
- *Risk:* The human is unpractised explaining ADR-003/ADR-004 aloud (Gate 3 criterion). *Mitigation:* `docs/INTERVIEW_PREP.md` rehearsal rows; those two ADRs deliberately narrate their rationales.

## Verification

- `scripts/verify-kit.sh` (structure) passes with the ADR set present.
- Phase 4 acceptance: a clean checkout installs, migrates and runs basic checks (`phases/PHASE-04-foundation-deploy.md` Gate 4); CI green on a PR with the Postgres service container.
- The *content* verification for this ADR is operational, not testable until code exists: the layering rule is reviewed at Gate 4 (clean-architecture guard) and exercised by the Phase 7–10 test layout (`docs/TEST_PLAN.md`).

## Revisit conditions

- H-4: no hosting option allows the second database role → reconsider the deploy target (stack itself can stand).
- The human prefers Python after trying the stack → only the commands change (`PROPOSED_DEFAULTS.md` D-1 note); this ADR must then be superseded, not silently edited.
- An interview-critical feature needs a subsystem the layering cannot host → extend D-2 only with an ADR amendment here, never by ad-hoc code.
