# ADR-002: Ledger model, sign convention and clearing account (D-4, D-5, D-6)

- **Status:** Proposed — awaiting Gate 3 human acceptance (naming pair `accounts.event_last_seq` / `account_event_seq`, closing rule and merged timeline were approved in the 2026-11-07 Gate 2 decision set, recorded in `docs/DISCOVERY.md` §5a)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.2; `phases/PHASE-03-architecture.md`)

## Context

`docs/DATA_MODEL.md` lists three decisions as "still requiring an ADR": (1) debit/credit sign convention, (2) clearing-account behaviour for external movements, (3) cached balance versus ledger-derived balance. Two other constraints bind this decision: no overdraft in v1 (human-confirmed 2026-11-06 — invariant I3) and append-only ledger records (I2, ADR-005). The challenge also demands that a refused attempt never be represented as a successful posting, and that statements render a deterministic ordered timeline.

Money representation is fixed by earlier human decisions (INR-only, integer minor units/paise, `BIGINT` storage, raw-token validation with direct `BigInt` conversion, strings-only JSON serialisation — T-049) and restated here as part of the model.

## Decision drivers

- Conservation must be *provable in stored data*, not just in responses (FIN-001/FIN-002, `assertGlobalInvariants`).
- Concurrent deposits/withdrawals hitting one clearing account must not serialise the whole system (T-043 context).
- Every posting and statement position must survive clock skew (`occurred_at` is never the ordering key — decision 9 / T-033).
- Explainability: double-entry with explicit sides is industry-standard and easiest to defend.

## Options considered

1. **Signed-delta entries** (`postings(delta_minor)` without sides) — shorter rows, but conservation checks and journal balance meaning both depend on a convention that is easy to get wrong silently; harder to explain in one sentence.
2. **Credit-normal double entry (chosen)** — explicit `DEBIT`/`CREDIT` sides, positive `amount_minor`; customer balance = Σ credits − Σ debits; "balanced" means Σ debits = Σ credits per journal (checks as data, not conventions).
3. **Ledger-derived-only balances** (no cached balance) — always consistent, but statement/balance reads become aggregate scans or a maintained view, and running-balance pagination gets complex; rejected for the demo while reconciliation against a cached value is retained as the honest check instead (cached balance treated as the read model that must equal the ledger).

## Decision

1. **Sign convention — credit-normal double entry.** `journal_transactions` (one per movement) holds `ledger_entries` (≥ 2 per journal), each entry with `direction ∈ {DEBIT, CREDIT}` and **positive** `amount_minor`. Customer account balance = Σ credits − Σ debits. Deposit: debit `EXTERNAL_CLEARING`, credit customer. Withdrawal: debit customer, credit clearing. Transfer: debit source, credit destination. Refused attempts are **never** postings; they are `transaction_attempts` rows (ADR-004).
2. **Invariant I1 — per-journal balance:** for every journal, Σ debits = Σ credits, **≥ 2 entries, and one consistent currency** (each entry's `amount_minor > 0` and `direction ∈ {DEBIT,CREDIT}` are column CHECKs). Enforced by the domain journal builder **and** a `DEFERRABLE INITIALLY DEFERRED` pair of constraint triggers sharing the named function `assert_journal_balanced()` (full body in `docs/schema-draft.sql`): one anchored on `journal_transactions` — it fires at COMMIT **even when a journal was inserted with zero entries**, which a trigger on `ledger_entries` alone could never catch (no entry row ⇒ no trigger event); one anchored on `ledger_entries` — it aggregates the whole journal at its COMMIT, guarding entry inserts against an existing journal, including an out-of-band later INSERT the journal trigger alone would not see. Verified PostgreSQL semantics: constraint triggers are AFTER-ROW triggers, and deferred ones execute at the end of the transaction where all of the transaction's changes are visible — so statement order (journal first, entries after) is irrelevant. Any failure raises there and aborts the **entire** transaction — journal + entries + balances + key-row state roll back together; no partial journal state can commit (JBL-001). Global conservation: Σ all balances including clearing = 0; Σ customer balances = −(clearing balance) = net external deposits − withdrawals.
3. **Clearing treatment:** `EXTERNAL_CLEARING` (and the reserved `ADJUSTMENT` kind) are `SYSTEM` accounts — their balance is **ledger-derived only**, may be negative (clearing is the contra of net external money), and is **never row-locked and never cached**: locking it would serialise every external movement in the system (the tuning reason itself). A transfer (or deposit/withdrawal) whose destination is a SYSTEM account is refused in-transaction (T-043, DEST-001).
4. **Balance read model (D-6):** `accounts.kind ∈ {CUSTOMER, SYSTEM}`; only CUSTOMER rows carry a cached `balance_minor` and the shared per-account event counter `event_last_seq`; SYSTEM rows carry NULL for both. Customers also carry the no-overdraft backstop `balance_minor >= 0` (I3 — DB-level guard if application logic ever slips) and the BIGINT-overflow upper cap (D-4) so repeated deposits cannot overflow per-account arithmetic. The cached value is updated only inside the posting transaction under the account row lock and must equal the ledger sum — enforced by reconciliation tests, and checked globally by `assertGlobalInvariants` after every integration and concurrency test.
5. **Event sequencing:** the counter is `accounts.event_last_seq` (bumped only under that account's `FOR UPDATE` lock; NULL for SYSTEM rows); each posting and each locked business refusal records its allocated position as `account_event_seq`; unresolved/unsequenced rows (`FAILED`, pre-lock and authorisation refusals) record `global_seq` from the dedicated non-transactional `attempt_global_seq` SEQUENCE (deliberately **not** gap-free — it is a tiebreak, not a conservation primitive). Statement *event* order always follows the counter, never any clock (`docs/REFUSAL_CODES.md` §5). Statement display = one merged timeline backed by the `events`/`attempts` categories (decision 9). This closes DATA_MODEL open item 4 (how refused attempts relate to running balances) together with ADR-004.
6. **Money representation (D-4):** `BIGINT` minor units (paise), single currency `INR` in v1 (currency column compared, not assumed); amounts validated at the HTTP boundary as raw JSON integer tokens converted directly to `BigInt` (never via `Number`); `> 0` and the per-operation cap are business validations (`INVALID_AMOUNT`, 409). Every money/sequence integer is serialised as a JSON **string** in responses and stored replay bodies (T-049). No `float`/`real` anywhere in the money path.

SQL draft: `docs/schema-draft.sql` (draft only — becomes a `node-pg-migrate` migration after Gate 3 and H-4 host-role verification). Cross-checked against the approved naming in the 2026-11-07 decision set.

## Consequences

### Positive
- Conservation, per-journal balance and no-overdraft are each independently checkable in stored data; every invariant has a named test (`FIN-001`, `FIN-002`, `INV-001`, reconciliation).
- Postings are human-readable ("money left A, arrived at B") without sign-flip tables — interview-friendly.
- Clock skew cannot corrupt statement order — the counter is the sole event-ordering authority.

### Negative / trade-offs
- Cached customer balances introduce the classic drift risk; mitigated by the reconciliation + `assertGlobalInvariants` guards being mandatory after every money-touching test.
- SYSTEM-clearing aggregate requires a ledger scan for its balance — acceptable at demo scale; a materialised view is possible later without model change.

### Risks and mitigations
- *Risk:* posting service accidentally locks/updates a SYSTEM row (serialisation bug). *Mitigation:* ADR-003 lock discipline + a destination-kind pre-lock check (`SYSTEM_ACCOUNT_NOT_ALLOWED` path, §2); `FOR UPDATE` on rows whose kind is SYSTEM fails the audit review.
- *Risk:* deferred I1 triggers hide an unbalanced (or empty) journal until commit. *Mitigation:* the raise lands inside the deferred phase and aborts the whole transaction — **nothing partial is ever persisted** (JBL-001 asserts zero residue after every rejection); the domain builder still refuses unbalanced receipts up-front (unit test); assertion helper re-verifies post-commit; FIN-002 fault-injection proves rollback.
- *Risk:* a separate transaction appends entries to an existing POSTED journal in a way that keeps it balanced (INSERT-only privileges permit the append; the I1 triggers accept it by construction). *Mitigation:* v1 code never appends to an existing journal — corrections are new compensating journals (this ADR, item 1); the residual is disclosed and revisited via the H-5 hash chain / Phase 12 adversarial review; an *unbalanced* such append is rejected by the `ledger_entries` trigger.

## Verification

- `FIN-001` (transfer conserves), `FIN-002` (fault injection → full rollback), `INV-001` (ledger-derived totals equal stored balances), **`JBL-001` ✱ (new at Gate 3 final review, integration — run in Phase 5/6 against real PostgreSQL)**: zero-entry journal rejected at COMMIT; one-entry journal rejected; unbalanced multi-entry journal rejected; balanced two-entry and multi-entry journals commit; currency-inconsistent journal rejected; every rejection leaves **zero** journal/entry/attempt/balance rows (full rollback); concurrent postings each satisfy I1 (`journalBalance.test.ts`); mutation check: disabling the deferred triggers makes JBL-001 fail (restored immediately); reconciliation query equality, `assertGlobalInvariants` after each integration/concurrency test, `STMT-001`/`STMT-002` merged-timeline ordering with non-monotonic-clock fixtures, `AUTO-…`/amount parse tests (`validation/amount.test.ts`), `SER-…` serialisation checks (JSON strings), audit `LED-001` (append-only, ADR-005).
- **Exact PostgreSQL test for implementation (Phase 4/5):** with the migration applied, per case open one transaction, insert the journal (+entries), and `COMMIT`: expected outcome for the zero-entry, one-entry, unbalanced and currency-mismatch cases is a COMMIT-time failure from the deferred trigger — the function's `RAISE EXCEPTION` surfaces as SQLSTATE **`P0001` (`raise_exception`)** (a deferred *constraint trigger* is not a declarative CHECK, so no `23514`/`23515` constraint code appears; the raise aborts the transaction), with `SELECT count(*) FROM journal_transactions / ledger_entries` unchanged after the aborted COMMIT; balanced cases commit and reconcile. Concurrency variant: two connections insert two balanced journals simultaneously — both commit, I1 holds per journal (`assertGlobalInvariants`).
- Database experiments: attempt `UPDATE`/`DELETE` on ledger tables as `ledgerline_app` (must be rejected) — P6.5/P12.5.

## Revisit conditions

- A second currency arrives → D-4 "single currency" clause must be superseded, not patched.
- Statement load makes per-journal aggregate scans unacceptable at real scale → reconsider cached-SYSTEM balances explicitly via a new ADR.
- The human opts into the hash chain (H-5) → ADR-005 amendment records the per-account `row_hash` extension; the ledger model itself does not change.
