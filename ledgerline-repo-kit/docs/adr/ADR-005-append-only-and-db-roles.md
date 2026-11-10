# ADR-005: Append-only enforcement and database roles (D-10)

- **Status:** Proposed — awaiting Gate 3 human acceptance (accepted-residual-risk treatment follows the kit's honesty rules; `phases/PHASE-03-architecture.md` P3.5 explicitly requires the "incl. accepted residual risk" statement here)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.5)

## Context

The problem statement requires append-only ledger records: corrections happen as compensating entries, never by editing history (I2). The institutionally adversarial question is explicit in the challenge: *what stops anyone — including the application itself — from editing or deleting a posting?* (P6.5, P12.5). Privilege design must also survive the demo constraint: migrations need a privileged role, while the runtime must not be able to mutate history even through a code bug.

## Decision drivers

- Defense in depth, each layer independently testable (Gate 8-style "fail when the protection is removed").
- Small operational surface (no extra infrastructure beyond database roles).
- Honest residual-risk disclosure is a marking criterion (`PROMPTS.md`/`THREATS.md` truthfulness).

## Options considered

1. **Application-layer guard only** (deny update/delete in the repository layer) — one removed line away from disaster; an intern's refactor silently re-enables writes. Fails Gate 8's "fail when the protection is removed" philosophy.
2. **Database roles only (no triggers)** — correct default grants, but grants alone don't *reject* a misuse from a role with mistakenly widened privileges, and give nothing for the superuser story.
3. **Selected: layered enforcement** — roles + grants + triggers + (optional) hash chain, each layer nameable and testable.

## Decision

Enforcement is layered, each layer required to be independently tested:

1. **Two database roles.** `ledgerline_owner` — runs migrations only (schema DDL); `ledgerline_app` — the runtime role.
2. **Grants — with the runtime/app boundary decided.** On the **append-only set** (`journal_transactions`, `ledger_entries`, `transaction_attempts`, `audit_events`) `ledgerline_app` receives `SELECT, INSERT` only — **no** `UPDATE`, `DELETE` or `TRUNCATE` anywhere on it. Schema-migration privileges (a *DDL* concern: `CREATE`/`ALTER`/`DROP`) and ledger-*data* mutation privileges (`UPDATE`/`DELETE`/`TRUNCATE` on stored rows) are different privileges owned by different roles: only the owner ever holds DDL, and the runtime never holds ledger-data mutation.
   `idempotency_records` is separately scoped: `SELECT, INSERT, UPDATE` — the only UPDATE use is D-8 step 7 (finalising the stored response on the key row the same claiming transaction inserted); there is **no** DELETE (no expiry in v1; any deletion is owner-role SQL only, disclosed — T-038, `AUTHZ_MATRIX.md` §B).
   **Accounts update boundary (decided at Gate 3, closing the former "unexplained permission gap"): `ledgerline_app` receives exactly one `UPDATE` grant on data tables — column-level, on `accounts` (`balance_minor`, `event_last_seq`, `updated_at`, `status`)** — so cached balances and the per-account event counter are written only by the posting transaction that already holds that account's `FOR UPDATE` row lock (ADR-003), and `status` only inside the audited admin lifecycle (`AUTHZ_MATRIX.md` §F). Every other `accounts` column (id, account_number, label, currency_code, kind) is immutable post-creation: no grant covers it. Lifecycle tables (`account_permissions`, `sessions`, `users`) carry their scoped `SELECT, INSERT, UPDATE` for the admin/revocation paths — and the UPDATE privilege there is *necessary*, not merely permitted: PostgreSQL requires the UPDATE privilege on at least one column of every table named in a locking clause before `FOR SHARE`/`FOR UPDATE` is allowed at all (PostgreSQL SELECT reference, verified 2026-11-08), and the money path reads all three `FOR SHARE`. **`admin_control` is decided at the Gate 3 final review: `GRANT SELECT, UPDATE (updated_at) ON admin_control TO ledgerline_app`** — the minimal grant satisfying the locking-clause rule for the count-reducing `FOR UPDATE` serialisation point (`AUTHZ_MATRIX.md` §C.2) while keeping `updated_at` the only writable column (a harmless lifecycle touch; `id` is immutable, no DELETE/TRUNCATE exists). *Considered and not chosen for the lock as well:* a `SECURITY DEFINER` lock function owned by `ledgerline_owner` — the same objections as for the accounts decision below (extra in-path hop, hidden write, ownership/`search_path` review burden); the human may override at Gate 3. The exact grant list remains written out in `docs/schema-draft.sql`'s planned-grants block. *Considered and not chosen:* a restricted `SECURITY DEFINER` function as the sole writer of the accounts columns — it adds a PL/pgSQL hop inside the lock critical section, one more object to review, and hides the actual write inside a function body; the column-level grant keeps every money-path write visible in the same posting SQL the human must be able to explain, and the same reconciliation + `assertGlobalInvariants` honesty checks (ADR-002) apply either way.
3. **Triggers.** `BEFORE UPDATE OR DELETE` row trigger and `BEFORE TRUNCATE` statement trigger on each of those tables raise an exception — named in the schema draft (`docs/schema-draft.sql`), e.g. `ledger_entries_append_only`. These guards reject even a legitimately privileged session that accidentally enables writes. **Trigger behaviour is role-independent:** the triggers fire for **every** session, including `ledgerline_owner`. They are not a licence for the owner: migrations are DDL (`CREATE`/`ALTER`/`DROP`), which never fires a row-`UPDATE`/`DELETE` trigger, so the owner's migration work needs no trigger exception — while owner-role `UPDATE`/`DELETE` on ledger **data** rows is refused exactly like the app's. The only bypass is an explicit `ALTER TABLE … DISABLE TRIGGER`, which requires table-owner/superuser privileges — that is the disclosed residual (item 5, `THREATS.md` T-026), not an allowed path.
4. **Hash chain (deferred, optional stretch).** `row_hash = sha256(prev_row_hash ‖ canonical fields)` per account, written under the account lock and verified by reconciliation, makes tampering by a privileged operator *detectable*. This is listed under H-5 in `PROPOSED_DEFAULTS.md` and is **not** scheduled for v1 without explicit approval — the ledger model in ADR-002 does not depend on it.
5. **Accepted residual risk (disclosed, not hidden):** a database **superuser or the owner role** can disable triggers, `ALTER` the schema or grant themselves `UPDATE`. Nothing in v1 defends against a hostile database superuser; this is disclosed in `THREATS.md` (business corrective-posting paths after Gate 9 also fall under this operator power and are documented). Mitigating *visibility* of abuse is the optional hash chain (item 4), which is why it stays on the H-5 list.

## Consequences

### Positive
- Every layer fails *verifiably*: a removed trigger or a widened grant is caught by its own test (P6.5 / P12.5), matching the "fail when protection is removed" gate.
- Migrations and runtime separation also stop the runtime role from DDL entirely — schema evolution cannot happen via a code-level accident.

### Negative / trade-offs
- Two roles mean migration tooling must connect as owner while tests run as app — one more piece of local setup, encoded in `docker-compose.yml` and `db/` tooling in Phase 4.
- Trigger errors are opaque if messages are generic — the triggers must raise *named*, human-readable exceptions (they double as interview evidence).

### Risks and mitigations
- *Risk:* forgotten `TRUNCATE` guard on a new table. *Mitigation:* schema draft declares the guard with each append-only-table; the LED-001 test file enumerates the guarded tables and fails when one is added without a trigger.
- *Risk:* someone runs the app with the owner credentials to "simplify local setup". *Mitigation:* Phase 4 wiring (`config/` env validation) must fail fast if the app's connection string equals the owner role; a test asserts the runtime connection holds **no** `UPDATE` on `ledger_entries` (nor table-level `UPDATE` on `accounts` — only the decided column-level list) and fails the append-only trigger as owner.

## Data-access transaction strategy (BalanceVault expansion — human decision 2026-11-09; written BEFORE implementation)

The expanded challenge mandates **Prisma Client for typed routine access** while the financial engine stays raw SQL. Because Prisma and `pg` hold **separate pooled connections**, a Prisma transaction can never absorb statements issued through an independent `pg` client. The binding strategy, which this ADR makes normative before any implementation begins:

1. **Single transaction owner per financial operation — the money path stays 100% raw `pg`.** Every financial operation (deposit, withdrawal, transfer; every route that touches locks, balances, `event_last_seq` allocation, ledger/`journal_transactions` inserts, idempotency claims and stored outcomes, refusal attempt rows) runs inside **one explicit `pg` client transaction** owned by the DomainTransactionRunner specified in the kit. All locks, checks, writes and audit rows of that operation participate in that single PostgreSQL transaction. **A Prisma transaction is never opened inside a financial operation, and no financial statement is ever executed through Prisma.** There is no partial Prisma/`pg` interleaving anywhere in D-8's executed code.
2. **Prisma is the routine-CRUD client**: user/session/account/grant administration (non-financial), audit-event recording for authentications and administrative actions, statement/audit-view reads and pagination. Each Prisma call or interactive transaction owns exactly its own database transaction; no Prisma transaction holds money-path locks, so no interleaving deadlock or lost-update surface exists with the money path (the shared rows they touch, e.g. `users`, are only read by Prisma flows or mutated by disjoint single-statement flows).
3. **Never split one financial operation across transactions.** If a flow conceptually starts as routine (e.g. "register user") and later requires a financial or lock-anchored effect (e.g. provisioning an account), the two parts are separate, each internally atomic, and the financial/locked part uses the raw-`pg` transaction. Composition guarantees come from ordering (complete the routine write, then the financial write, with the financial part's own refusal handling) — never from spanning two connection pools inside one logical operation.
4. **Same database, same roles:** Prisma connects to the **same PostgreSQL database** as `pg`, under the **same runtime role `ledgerline_app`** (`DATABASE_URL` for Prisma config). Prisma therefore enjoys neither owner privileges nor any grant `ledgerline_app` lacks; all LED-001/LED-002 runtime-role boundary tests apply to Prisma connections equally — verified in the runtime-role privilege test by running the equivalent statements through both clients.
5. **Migration authority stays node-pg-migrate.** `node-pg-migrate` is the authoritative migration system (including role creation, tables, grants, constraints). Prisma's migration engine (`prisma migrate`) is **not used** — no second competing migration authority exists. `prisma generate` uses a checked-in `schema.prisma` that **mirrors the migrated schema**; it is updated in the same change-set as the migration that alters what it mirrors, and drift is asserted by a light introspection check in CI (fail-diff, not autofix).
6. **Append-only and invariants unaffected.** The append-only trigger layer and the runtime-role privilege model apply to any client, Prisma included; a Prisma-coded flow cannot UPDATE/DELETE financial history because `ledgerline_app`'s grants and triggers do not depend on the client library. `assertGlobalInvariants` re-checkable from both clients remains the economic backstop (ADR-002).

**Status of this section:** design decision record added by direct human instruction (2026-11-09); the ADR's overall Status stays `Proposed — awaiting Gate 3 human acceptance`, and the section is part of what Gate 3 acceptance will cover. Runtime-role and deployment verification (production role capability) is the H-4 item, required before the Phase 4 deployment step (P4.8) — now also covering "Prisma connects under `ledgerline_app` in the deployed environment".

### Expanded-challenge verification additions

- **PRODROLE-001:** in the deployed environment, verify `ledgerline_app` (used by BOTH `pg` and Prisma) can create/read its scoped objects, cannot access owner-only DDL or history mutation, and that the host permits this second role — before P4.8.
- **PRISMA-001 (drift):** `prisma generate && diff of introspected vs checked-in schema` shows no drift against the node-pg-migrate-migrated schema; CI fails on drift.
- **TX-BOUNDARY-001:** mutation check — an artificial attempt to route one financial statement through Prisma fails the money-path architecture guard (grep/lint for Prisma imports in the money-path modules fails).

## Verification

- `LED-001`: as `ledgerline_app`, attempt `UPDATE` and `DELETE` on each ledger/attempts/audit table and `TRUNCATE` → every statement rejected; each layer asserted independently (privilege layer: the grant itself; trigger layer: the mutation-check that widens then removes the grant must not change the outcome).
- **Owner-role statement test (Gate 3 correction — replaces the earlier, incorrect "owner allowed" expectation):** run the *same* `UPDATE`/`DELETE` statements on the ledger rows **as `ledgerline_owner`** → they are **rejected by the append-only trigger**, exactly as for `ledgerline_app`. Triggers fire for every session; the owner's legitimate work is migrations (DDL), which these triggers never interfere with. The sole bypass is an explicit `ALTER TABLE … DISABLE TRIGGER` (owner/superuser privilege) — that is the disclosed accepted residual (`THREATS.md` T-026; item 5 above), tested as *visible-and-intentional*, never as a permitted path. The verification expectation must never be written "the owner may mutate ledger data"; append-only enforcement is not weakened to make any test pass.
- **Accounts-grant boundary test:** as `ledgerline_app`, `UPDATE accounts SET balance_minor = …` (under the posting transaction) succeeds; `UPDATE accounts SET label = …` (any non-listed column) fails on privilege; `UPDATE ledger_entries …`/`journal_transactions …` fail on both privilege and trigger.
- **Admin-control privilege boundary test:** as `ledgerline_app`, `SELECT … FOR UPDATE` on the `admin_control` singleton succeeds (two concurrent sessions serialise — ADMIN-002); `UPDATE admin_control SET id = 2` fails (no UPDATE grant on `id`, plus the singleton CHECK); `DELETE`/`TRUNCATE` on `admin_control` fail. The boundary test also covers `FOR SHARE`: as `ledgerline_app`, two `FOR SHARE` reads on `sessions`/`users`/`account_permissions` succeed under the scoped table UPDATE grant (PostgreSQL locking-clause rule), but `FOR SHARE` on `audit_events` (SELECT/INSERT only) is not used anywhere in the design — the privilege pair is checked in `migrations.test.ts` (LED-002 runtime-role privileges).
- `assertGlobalInvariants` remains the continuous economic check (ADR-002).

## Revisit conditions

- The human opts into the hash chain (H-5) → this ADR is amended (chain layout, verification cadence); ADR-002 model unchanged.
- A background job ever needs ledger maintenance → it must run as a *third*, explicitly scoped role with its own ADR-analysed grant list; no widening of `ledgerline_app`.
