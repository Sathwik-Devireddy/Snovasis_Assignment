# Interview Preparation — Phase 3

*Date: 2026-11-14 · Answers are tied to the actual code at `main` @ `66f2b29`*

Companion documents: [`INTERVIEW_PREP.md`](INTERVIEW_PREP.md) (live-drill table
with file:line references and mutation exercises) and [`WRITEUP.md`](WRITEUP.md)
(what was built and what was deliberately left out). This document covers the
standard question set with answers you can defend from the code.

## Q1. Why double-entry accounting?

Because the books must be conserved by construction, not by convention. Every
money movement posts a **balanced journal** — equal and opposite debit/credit
entries in one transaction — and a deferred trigger pair
(`assert_journal_balanced`, `db/migrations/0003_ledger.js`) re-checks balance
at COMMIT: zero-entry, one-entry, unbalanced and cross-currency journals are
physically rejected. The application builds balanced journals, but the
*database* refuses to store an unbalanced one — so no forgotten code path can
corrupt the books. External money-in/out clears through a SYSTEM clearing
account, so every journal balances even when cash crosses the boundary.

## Q2. How are balances maintained?

Two representations, one authority. The **ledger entries are the authority**;
`accounts.balance_minor` is a **cached read model** updated inside the same
transaction as the postings (under the account's `FOR UPDATE` lock). Nothing
ever "sets a balance by writing a number". Reconciliation recomputes each
account's balance from `Σcredits − Σdebits` and compares it to the cache
(`domain/invariants.ts`, `routes/reconciliation.ts`); a divergence is reported,
never silently "fixed". SYSTEM accounts carry no cached balance by design —
their ledger-derived position is the authority.

## Q3. How are concurrent withdrawals handled?

Row locks + one transaction + a database backstop. Every money command is ONE
raw-`pg` transaction. Account rows are locked `SELECT … FOR UPDATE` in
**ascending id order** (deterministic, so opposite-direction transfers cannot
deadlock — `transactionRunner.ts` ~`:618`), and the balance is checked **inside
the lock**; a failing check commits a durable refusal row instead of moving
money. Proof: `CON-001` (N concurrent over-balance withdrawals → exactly one
succeeds), and the mutation check M3 — removing the lock made **both**
withdrawals succeed, caught by the `CHECK (balance_minor >= 0)` backstop and a
failing test. A read-then-write check without a lock would be insufficient.

## Q4. How does idempotency prevent duplicate transactions?

The duplicate serialiser is a **database uniqueness constraint**, not a flag:
`idempotency_records` has UNIQUE `(actor_id, operation, idempotency_key)`
(migration 0002). The claim is an `INSERT … ON CONFLICT DO NOTHING` inside the
transaction; a concurrent twin **blocks on the uncommitted unique row**, then
replays the stored `response_body` after passing the replay re-evaluation gate
(session/grants/status still valid). Same key + different canonical request
hash → `409 KEY_REUSED`. Refusals and infrastructure failures (timeouts) do
**not** consume the key, so a retry after a `503 LOCK_TIMEOUT` safely reuses
it — the key is only bound by a committed outcome. Verified by `IDEM-003/005`,
mutation M2 (dropping the constraint made `IDEM-003` fail), and this phase's
live seed re-run (second run replayed both movements, balances unchanged).

## Q5. How are sessions secured?

Opaque 256-bit random tokens; only the SHA-256 hash is stored, the raw token
never touches the disk or logs. The cookie is `HttpOnly; SameSite=Lax; Path=/`
with `Secure` from a config-checked flag that **refuses to boot in production
unless `COOKIE_SECURE=true`**. Every request re-derives the actor from the
database (active predicate `revoked_at IS NULL AND expires_at > now()`, user
status re-checked) — nothing is trusted from the client. Login/logout/audit
rows commit atomically with their state changes. Unknown-user login pays the
same argon2id cost against a real never-matching DUMMY_HASH, so timing cannot
enumerate accounts, and all login failures share one uniform 401 envelope.
Revocation is server-side (logout, role change, disable) — the browser can
never clear an HttpOnly session cookie itself, and the UI only treats logout
as done after a confirmed 2xx/401.

## Q6. How is RBAC enforced?

Server-side, deny-by-default, twice. Route level: every protected route
resolves the actor and gates on role. Transaction level: the money path
re-reads role, grants and account status `FOR SHARE` **inside** the
transaction, so a concurrent revocation/role-change linearises correctly (no
TOCTOU window). Account-scoped access is grant-based (`VIEW`/`WITHDRAW`/
`TRANSFER` on specific accounts), enforced in the SQL itself via parameterised
`EXISTS` — a holder literally cannot select a row they cannot see (uniform
404, two-sided truth). Special rules: external deposits are ADMIN-only
(approved decision H-2 — holders self-depositing would mint money); admins can
never grant to themselves (`SELF_GRANT_REFUSED`); the last active ADMIN cannot
be demoted/disabled (singleton `admin_control` row + count-under-lock);
self-registration can only ever produce `ACCOUNT_HOLDER` (strict schema +
server-fixed role). The full matrix is `AUTHZ_MATRIX.md`; enforcement is in
the API, not the UI.

## Q7. Why PostgreSQL?

Because the integrity guarantees live in the database engine itself:
ACID transactions with real row-level locking (`FOR UPDATE`/`FOR SHARE`),
declarative CHECK constraints as a defence-in-depth backstop, **deferred
constraint triggers** that evaluate journal balance at COMMIT (the only way to
catch a zero-entry journal), unique constraints as the idempotency mutex, and
**role-based privilege separation** (runtime role cannot UPDATE/DELETE ledger
or audit rows — enforced independently of application code). BigInt/NUMERIC
arithmetic keeps money exact (no floating point). PostgreSQL 17 locally,
Neon in production — same engine, same behaviour.

## Q8. What is the role of Redis?

Availability control only: the fixed-window rate limiter's counters. Redis
holds **no balances, ledger, idempotency, session or authority state** — it is
deliberately fail-soft: if Redis is unavailable, requests still proceed and
the durable DB-side T-042 attempt cap remains the backstop. A cache outage can
never corrupt financial state, because the cache cannot influence it. Sessions
live in PostgreSQL (durable, revocable, auditable) — not in Redis.

## Q9. How does reconciliation work?

Read-only recomputation from the immutable ledger, never a mutation. Per
account: derived balance (`Σcredits − Σdebits`), entry/journal counts, and
event-counter integrity (`allocated seq count == event_last_seq`, Σseq ==
n(n+1)/2 — catches gaps and duplicates). Globally: `assertGlobalInvariants`
plus the conservation identity — Σ customer derived balances + Σ clearing
derived balance = **0** (both sides derived from ledger entries, never from
cached balances, because a cached-sum check would falsely read zero). Any
violation is reported in the response; nothing is auto-"repaired" — a
divergence is an incident to investigate, not a number to overwrite.

## Q10. How are database permissions restricted?

Two runtime roles plus triggers. `balancevault_bootstrap` (superuser) runs
only migration 0001 to create the roles; `ledgerline_owner` owns DDL and runs
migrations 0002+; **`ledgerline_app` is the runtime role** with DML-only
grants — and critically **no UPDATE/DELETE/TRUNCATE on ledger entries,
journals, audit events or attempt rows**. Append-only is additionally enforced
by row-level and TRUNCATE triggers that fire for **every** session, including
the owner. `prisma migrate` is never invoked; node-pg-migrate is the only
migration authority. Disclosed residual: the owner can bypass with an explicit
`ALTER TABLE … DISABLE TRIGGER` — that is a deliberate, accepted residual
(ADR-005), not an oversight.

## Q11. What happens when a request times out after the transaction commits?

The client retries with the **same idempotency key** and gets the stored
result — no second movement. Mechanics: the outcome is only "unknown" to the
client; it is committed state to the server. The stored `response_body` on the
idempotency row replays for an identical payload. The frontend encodes this
contract: `classifyMoneyError` maps 408/503 LOCK_TIMEOUT/5xx/network to
"outcome not known — retry with the SAME key", never presenting an unknown
outcome as a confirmed refusal, and the money intent binds the key to the
payload so a retry re-sends the original body. If the transaction *rolled
back* (timeout before commit, SQLSTATE 57014), the server maps it to
`503 LOCK_TIMEOUT` with the key **not consumed**, and a refusal row is not
fabricated mid-rollback — again safe to retry with the same key.

## Q12. What do you know is still open?

Stated plainly (never claim otherwise):
- **Production deposit journey: `BLOCKED — awaiting owner-controlled
  real-admin bootstrap`** — the first-admin slot is deliberately reserved;
  production has no ADMIN, so the ADMIN role cannot be demoed there yet.
- Accepted residual T-050 (bootstrap operator identity is a claim, not proof).
- OPEN threats with conditions: T-017, T-018, T-020, T-038, T-063
  (postcss advisories via `next@15.5.29`, build-time only).
- The shared rate-limit bucket behind Render's router (S-1 in
  [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md)) — owner decision recorded.
- No browser E2E suite (API: 202 real-DB tests; web: 48; journeys verified
  manually through the real proxy).

## Practice pointers

- If asked to "make this change live" (e.g. a per-day withdrawal limit): the
  rule belongs next to the other under-lock checks in
  `transactionRunner.ts` (balance-check region), plus a test in
  `ledgerCore.test.ts` — no handler change needed.
- The mutation drills (drop the CHECK, drop the unique constraint, remove the
  lock — M1/M2/M3) were **executed**, with the failing output recorded in
  `THREATS.md` rev 3; you can narrate them as evidence, not theory.
- Full walking-tour references: [`INTERVIEW_PREP.md`](INTERVIEW_PREP.md).
