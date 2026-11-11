import { describe, it, expect } from "vitest";
import { assertGlobalInvariants } from "../../src/domain/invariants.js";

/**
 * P6.7: `assertGlobalInvariants` is wired (replacing the P4.6 throwing stub).
 * The anti-no-op contract is preserved differently now: the function must
 * actually QUERY the authoritative ledger (not return a fabricated pass) and
 * must REPORT every violation class it is responsible for.
 */
describe("assertGlobalInvariants (P6.7, real checks)", () => {
  /** Minimal PoolClient stand-in answering by SQL shape. */
  function fakeClient(routes: Array<{ match: RegExp; rows: Array<Record<string, unknown>> }>) {
    return {
      query: async (sql: string) => {
        const hit = routes.find((r) => r.match.test(sql));
        if (!hit) throw new Error(`fakeClient: unexpected SQL: ${sql.slice(0, 60)}`);
        return { rows: hit.rows as never[] };
      },
    } as never;
  }

  it("is not a silent no-op: it queries journals AND per-account aggregates", async () => {
    const seen: string[] = [];
    const client = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [] as never[] };
      },
    } as never;
    const report = await assertGlobalInvariants(client);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.some((s) => s.includes("ledger_entries"))).toBe(true);
    expect(seen.some((s) => s.includes("transaction_attempts"))).toBe(true);
    expect(report).toEqual({ accountsChecked: 0, journalsChecked: 0, violations: [] });
  });

  it("reports stored-vs-derived mismatches and non-gap-free event sequences", async () => {
    const client = fakeClient([
      { match: /GROUP BY journal_transaction_id\s+HAVING/, rows: [] },
      { match: /COUNT\(\*\).*journal_transactions|FROM journal_transactions/, rows: [{ n: "3" }] },
      {
        match: /ledger_agg/,
        rows: [
          {
            account_id: "42",
            kind: "CUSTOMER",
            stored: "100",
            derived: "90",
            event_last_seq: "3",
            seq_count: "2",
            seq_sum: "3",
          },
        ],
      },
    ]);
    const report = await assertGlobalInvariants(client);
    expect(report.journalsChecked).toBe(3);
    expect(report.accountsChecked).toBe(1);
    expect(report.violations).toHaveLength(2);
    expect(report.violations[0]).toContain("account 42: stored balance 100 <> ledger-derived 90");
    expect(report.violations[1]).toContain("account 42: event sequence not gap-free 1..3");
  });
});
