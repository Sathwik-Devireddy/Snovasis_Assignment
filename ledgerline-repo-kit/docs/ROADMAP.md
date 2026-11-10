# Delivery Roadmap — SDLC with Micro-Phases

**Challenge window:** 6 November 2026, 09:00 IST to 12 November 2026, 18:00 IST. The timeline is a prioritization guide, not permission to skip gates. Deploy before the final day.

## Lifecycle model

Discover → Define → Design → Build → Verify → Release → Operate/Present. Each phase has a gate. A phase cannot be called complete merely because its files exist.

## Phase 0 — Candidate and challenge readiness

**Target:** immediately on 6 Nov. **Owner:** human developer.

- [ ] P0.1 Sign in to the challenge portal.
- [ ] P0.2 Change the temporary password and store it in a password manager.
- [ ] P0.3 Complete My Profile; confirm the portal allows submission creation.
- [ ] P0.4 Read the full problem statement and event instructions.
- [ ] P0.5 Create/open the submission form and save it; note how to return to it.
- [ ] P0.6 Ask the placement cell to resolve the repository-visibility conflict: email says do not make it public before the deadline; hand-in list asks for a public repository.
- [ ] P0.7 Confirm the exact stack and hosting account access.

**Gate 0:** profile complete, portal access secure, instructions read, repo visibility ambiguity escalated. Do not lose time to account recovery.

## Phase 1 — Discovery and repository audit (read-only)

**Target:** 6 Nov. **Agents:** product analyst, frontend audit agent, system architect.

- [ ] P1.1 Inspect the repository tree, package manifests, backend entry point, migrations, tests, CI and deployment files.
- [ ] P1.2 Record existing stack and versions; do not assume the proposed baseline is already implemented.
- [ ] P1.3 Map current routes/pages, root layout, nested layouts, route groups and client/server component boundaries if Next.js is present.
- [ ] P1.4 Review UI hierarchy, responsive behavior, spacing, typography, colors, cards, buttons, form states and empty/error/loading states.
- [ ] P1.5 Identify duplicated UI, oversized components, mixed concerns, dependency cycles and dead code.
- [ ] P1.6 Map existing data models and money-moving routes, if any.
- [ ] P1.7 Run the existing test suite and record baseline failures without modifying code.
- [ ] P1.8 Produce a prioritized audit: critical correctness/security blockers, high-impact maintainability issues, polish opportunities.

**Gate 1:** human reviews the read-only audit. No code changes are authorized by this phase.

## Phase 2 — Requirements, scope and threat discovery

**Target:** 6 Nov. **Agents:** product analyst, security reviewer, QA engineer.

- [ ] P2.1 Convert the ten challenge requirements into observable acceptance criteria.
- [ ] P2.2 Agree roles and account-level permission matrix.
- [ ] P2.3 Define no-overdraft policy and permitted external deposit/withdrawal model.
- [ ] P2.4 Define money unit (integer minor units), currency handling and rounding policy.
- [ ] P2.5 Define what counts as a refused attempt and what appears in statements.
- [ ] P2.6 Define idempotency scope, key retention, payload mismatch and retry behavior.
- [ ] P2.7 Enumerate threats in `THREATS.md`, including attack path, control, test ID and residual risk.
- [ ] P2.8 Write the first project acceptance checklist and non-goals.

**Gate 2:** product requirements, role matrix, invariants and top threats are approved. Unclear money semantics are not left to an agent's guess.

## Phase 3 — Architecture and technical design

**Target:** 6 Nov. **Agents:** system architect, database engineer, frontend audit agent.

- [ ] P3.1 Decide whether the existing stack is retained; record the decision in an ADR.
- [ ] P3.2 Define frontend/backend/database boundaries and local development topology.
- [ ] P3.3 Define the authoritative source for balances and ledger postings.
- [ ] P3.4 Select a concurrency strategy (for example, PostgreSQL row locks in a consistent account-ID order, or an equally defensible atomic strategy).
- [ ] P3.5 Define double-entry sign convention and clearing-account treatment for external deposits/withdrawals.
- [ ] P3.6 Define append-only enforcement at the database/application permission boundary.
- [ ] P3.7 Define idempotency transaction flow, including concurrent same-key requests and failed/refused attempts.
- [ ] P3.8 Define API contract and error semantics.
- [ ] P3.9 Define Next.js route groups/layouts and design-system boundaries if Next.js is used.
- [ ] P3.10 Define test layers and production-like PostgreSQL test environment.

**Gate 3:** architecture decisions are written and explainable; risks and trade-offs are documented. Human approval is required before schema/API/security-boundary implementation.

## Phase 4 — Repository and developer-experience foundation

**Target:** 6–7 Nov. **Agents:** backend, frontend, DevOps.

- [ ] P4.1 Establish a clean monorepo or preserve the existing structure; avoid gratuitous restructuring.
- [ ] P4.2 Add environment variable examples with placeholders only.
- [ ] P4.3 Configure formatter, linter, type checks and test commands.
- [ ] P4.4 Add database migration workflow and clean-database setup instructions.
- [ ] P4.5 Configure CI for lint, type check and fast tests.
- [ ] P4.6 Add health/readiness endpoints without exposing secrets or database details.
- [ ] P4.7 Establish a repeatable local seed-data workflow with demo-only accounts.
- [ ] P4.8 Make first real, scoped commits; add initial `PROMPTS.md` and `THREATS.md` entries as work occurs.

**Gate 4:** a clean checkout can install dependencies, configure environment, migrate and run basic checks.

## Phase 5 — Identity, sessions and authorization

**Target:** 7 Nov. **Agents:** backend, security, frontend.

- [ ] P5.1 Implement password hashing and secure login/logout/session handling.
- [ ] P5.2 Implement role assignment for administrator, account holder and auditor.
- [ ] P5.3 Implement account-level permissions — **approved v1 permissions only**: `VIEW`, `WITHDRAW`, `TRANSFER`. No per-account `DEPOSIT` grant is implemented in v1 (external deposits are ADMIN role-level authority under H-2; holders are never granted `DEPOSIT`); `ADJUST`/`ADJUSTMENT` is **not implemented — deferred under H-5**, not an active v1 capability.
- [ ] P5.4 Enforce authentication and authorization in backend middleware/service boundaries.
- [ ] P5.5 Prevent privilege escalation through client-supplied role/account IDs.
- [ ] P5.6 Add negative tests for unauthenticated, wrong-role and cross-account requests.
- [ ] P5.7 Build minimal login and role-aware navigation only after API behavior is tested.

**Gate 5:** every protected endpoint has explicit permission tests; UI visibility is not treated as authorization.

## Phase 6 — Account and ledger foundation

**Target:** 7 Nov. **Agents:** database, backend, QA.

- [ ] P6.1 Create migration for users, accounts, account permissions, journal transactions and ledger entries.
- [ ] P6.2 Store amounts as integer minor units; add positive-amount and valid-currency constraints.
- [ ] P6.3 Create a documented system clearing account or another approved balancing model for external money movement.
- [ ] P6.4 Add foreign keys, unique constraints and indexes for common account/statement queries.
- [ ] P6.5 Enforce ledger append-only behavior for the application's database role; test update/delete rejection.
- [ ] P6.6 Implement account creation and balance query.
- [ ] P6.7 Implement ledger posting service that writes a complete journal atomically.
- [ ] P6.8 Add unit/integration tests for balanced postings and account ownership.

**Gate 6:** ledger model, sign convention and append-only controls are documented and tested in PostgreSQL.

## Phase 7 — Deposits and withdrawals

**Target:** 8 Nov. **Agents:** backend, QA, security.

- [ ] P7.1 Implement deposit command with actor/account authorization.
- [ ] P7.2 Implement withdrawal command with server-side balance enforcement.
- [ ] P7.3 Ensure balance update and journal postings commit or roll back together.
- [ ] P7.4 Persist successful operation metadata and initiator.
- [ ] P7.5 Persist refused attempts according to the approved audit design.
- [ ] P7.6 Test zero, negative, fractional-minor-unit, excessive and malformed amounts.
- [ ] P7.7 Test deposit/withdrawal invariants and rollback behavior.

**Gate 7:** deposits and withdrawals are correct in integration tests against PostgreSQL; no floating-point money arithmetic.

## Phase 8 — Internal transfers and concurrency safety

**Target:** 8–9 Nov. **Agents:** backend, database, QA, security.

- [ ] P8.1 Implement transfer validation and reject same-account transfers.
- [ ] P8.2 Lock both accounts in a deterministic order, or implement the accepted equivalent.
- [ ] P8.3 Check available balance while holding the required lock/atomic guard.
- [ ] P8.4 Write sender and receiver postings plus balance changes in one transaction.
- [ ] P8.5 Ensure a failure at any intermediate point rolls back every financial mutation.
- [ ] P8.6 Add a concurrent withdrawal test using independent transactions/connections.
- [ ] P8.7 Add concurrent opposite-direction transfer test to detect deadlocks.
- [ ] P8.8 Add fault-injection/rollback test at a point between debit and credit.
- [ ] P8.9 Verify final balances against ledger-derived totals.

**Gate 8:** race tests fail when the protection is deliberately removed and pass with the real protection. A single sequential API test is not evidence of concurrency safety.

## Phase 9 — Idempotency and retry semantics

**Target:** 9 Nov. **Agents:** backend, database, QA.

- [ ] P9.1 Define key scope (actor + operation + key) and canonical payload hash.
- [ ] P9.2 Add database uniqueness constraint for the scoped key.
- [ ] P9.3 Persist the key and committed operation result consistently with the financial transaction.
- [ ] P9.4 Return the original response for same-key/same-payload retries.
- [ ] P9.5 Return a conflict for same-key/different-payload reuse.
- [ ] P9.6 Define and implement behavior when a retry arrives while the original is in flight.
- [ ] P9.7 Define how refused/failed attempts are recorded and whether the same key replays that outcome.
- [ ] P9.8 Test sequential replay and simultaneous duplicate requests with independent connections.
- [ ] P9.9 Verify exactly one journal transaction and one financial effect exist per key.

**Gate 9:** duplicate replay tests prove one effect in stored data, not merely one success response.

## Phase 10 — Statements, audit and reconciliation

**Target:** 9–10 Nov. **Agents:** backend, frontend, QA, security.

- [ ] P10.1 Implement account statement query with stable pagination and deterministic ordering.
- [ ] P10.2 Include debit, credit, resulting running balance and initiating actor.
- [ ] P10.3 Include refused attempts with safe reason/status metadata and no fabricated posting.
- [ ] P10.4 Implement an audit view restricted to permitted roles.
- [ ] P10.5 Implement reconciliation checks comparing account balance snapshots with ledger postings.
- [ ] P10.6 Test statement ordering, pagination, access scope and running-balance calculations.

**Gate 10:** an auditor can reconstruct what happened without being able to mutate it; statements reconcile to stored data.

## Phase 11 — Frontend experience and accessibility

**Target:** 9–10 Nov. **Agents:** frontend, frontend audit, QA.

- [ ] P11.1 Implement app shell and route groups based on the approved route map.
- [ ] P11.2 Build account list/detail and balance views.
- [ ] P11.3 Build deposit/withdrawal forms with explicit confirmation and clear error states.
- [ ] P11.4 Build transfer form; retain the same idempotency key when retrying the same user intent.
- [ ] P11.5 Build statements with debit/credit labels, status and running balance.
- [ ] P11.6 Add role-aware navigation without treating it as a security boundary.
- [ ] P11.7 Add loading, empty, failure, disabled, pending and success states.
- [ ] P11.8 Verify keyboard navigation, semantic HTML, labels, focus behavior and contrast.
- [ ] P11.9 Check mobile layouts and common viewport sizes.
- [ ] P11.10 Check bundle/render performance; optimize only measured bottlenecks.

**Gate 11:** core flows work end-to-end and are usable on desktop/mobile; API remains the authority for all financial decisions.

## Phase 12 — Adversarial verification and hardening

**Target:** 10–11 Nov. **Agents:** QA, security, backend, database.

- [ ] P12.1 Execute every threat in `THREATS.md` and record evidence.
- [ ] P12.2 Try simultaneous overdraw attempts.
- [ ] P12.3 Replay same-key requests and same-key/different-payload requests.
- [ ] P12.4 Attempt cross-user and cross-account operations via direct API calls.
- [ ] P12.5 Attempt ledger UPDATE/DELETE through the application's DB role.
- [ ] P12.6 Test invalid states, disabled accounts and permission revocation.
- [ ] P12.7 Test database failure/transaction rollback and retry behavior.
- [ ] P12.8 Run the complete test suite against PostgreSQL, not SQLite-only substitutes for lock behavior.
- [ ] P12.9 Ask a reviewer to remove one lock/check locally and verify the relevant test fails; restore it immediately.
- [ ] P12.10 Fix critical/high issues; record accepted residual risks honestly.

**Gate 12:** no known critical integrity/security defect is represented as fixed without a reproducible test. Any unresolved material defect is disclosed.

## Phase 13 — Deployment, documentation and release candidate

**Target:** deploy by 10 Nov; harden 11 Nov. **Agents:** DevOps, documentation, QA.

- [ ] P13.1 Provision production-like PostgreSQL and secrets through host environment settings.
- [ ] P13.2 Deploy API and frontend; run migrations deliberately.
- [ ] P13.3 Configure CORS, trusted origins, HTTPS, secure cookies/tokens and health checks.
- [ ] P13.4 Create least-privilege demo accounts for all three roles with fake data only.
- [ ] P13.5 Confirm seed credentials work and document them in README; rotate/remove any accidental default secrets.
- [ ] P13.6 Run smoke tests against the live URL.
- [ ] P13.7 Test live link in a private window and on another device/network.
- [ ] P13.8 Complete clean-clone setup, schema/migration, API docs and known-limitations docs.
- [ ] P13.9 Record a five-minute demo showing role differences and integrity tests/results.
- [ ] P13.10 Write the project summary, design explanation, AI-use summary and unfinished-work list.

**Gate 13:** live system opens without local credentials; docs reproduce the setup; demo and write-up are ready.

## Phase 14 — Submission and final freeze

**Target:** 12 Nov, well before 18:00 IST. **Owner:** human developer.

- [ ] P14.1 Re-read the event submission form and ensure all fields are saved.
- [ ] P14.2 Confirm repository visibility with placement-cell clarification; never violate the email's pre-deadline restriction.
- [ ] P14.3 Verify README, API docs, `THREATS.md`, `PROMPTS.md`, automated tests, schema/setup, live URL, demo and write-up.
- [ ] P14.4 Re-test the deployed link in private browsing on another device.
- [ ] P14.5 Check that no secrets, personal data or local database files are committed.
- [ ] P14.6 Complete final submission checkbox only when the form is ready; save and verify portal confirmation.
- [ ] P14.7 Stop changes before the 18:00 IST lock.

**Gate 14:** submission form is complete, live evidence is accessible and the developer can explain the implementation.

## Priority rule when time is short

Do not sacrifice financial correctness to add features. Preserve this order: authorization → balanced ledger → atomic no-overdraft movement → idempotency → real concurrency tests → statements/audit → deployment → UI polish → optional features. Cut optional features first.
