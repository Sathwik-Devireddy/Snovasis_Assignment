/**
 * `assertGlobalInvariants(db)` — P4.6 stub (filled in PHASE-06).
 *
 * Contract (ACCEPTANCE INV-001 / TEST_PLAN standing helpers): runs at the end
 * of EVERY integration and concurrency test and must fail loudly when a
 * financial invariant is violated. Checks land with the schema in Phase 6:
 *   1. every journal balances (Σ debits = Σ credits)
 *   2. every CUSTOMER balance equals its ledger sum and is ≥ 0
 *   3. Σ customer balances = − clearing balance
 *   4. per-account gap-free monotonic event counter (accounts.event_last_seq)
 *
 * Phase-4 stub: throws "not implemented" so a placeholder can never silently
 * masquerade as proven protection.
 */

export type MinimalDb = { query(sql: string): Promise<{ rows: unknown[] }> };

export async function assertGlobalInvariants(_db: MinimalDb): Promise<void> {
  throw new Error(
    "assertGlobalInvariants is a Phase-4 stub — financial checks are wired in Phase 6 (P4.6).",
  );
}
