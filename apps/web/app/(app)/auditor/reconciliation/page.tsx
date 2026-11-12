/**
 * Auditor: Reconciliation page (PHASE-10 P11.3/P10.4).
 *
 * GET /reconciliation/summary — global conservation totals and invariant
 * status. Read-only.
 */

"use client";

import { apiGet } from "@/lib/api";
import { useEffect, useState } from "react";

type ReconciliationSummary = {
  healthy: boolean;
  accountsChecked: number;
  journalsChecked: number;
  violations: string[];
  conservation: {
    customerBalancesTotal: string | null;
    clearingBalance: string | null;
    conserved: boolean;
  };
};

export default function ReconciliationPage() {
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiGet("/reconciliation/summary")) as ReconciliationSummary;
        if (!cancelled) setSummary(res);
      } catch (err) {
        if (!cancelled) {
          setError((err as { code?: string }).code === "ACCOUNT_NOT_FOUND" ? "Not permitted to view reconciliation." : "Failed to load reconciliation.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div>Loading reconciliation…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!summary) return <div>No data.</div>;

  return (
    <div className="card">
      <h2>Reconciliation Summary</h2>
      <div className={`badge ${summary.healthy ? "badge-success" : "badge-refused"}`}>
        {summary.healthy ? "HEALTHY — no violations" : "VIOLATIONS DETECTED"}
      </div>
      <table>
        <tbody>
          <tr><th>Accounts Checked</th><td className="mono">{summary.accountsChecked}</td></tr>
          <tr><th>Journals Checked</th><td className="mono">{summary.journalsChecked}</td></tr>
          <tr><th>Customer Balances Total</th><td className="mono">{summary.conservation.customerBalancesTotal ?? "—"} INR</td></tr>
          <tr><th>Clearing Balance</th><td className="mono">{summary.conservation.clearingBalance ?? "—"} INR</td></tr>
          <tr><th>Conserved (Σ = 0)</th><td>
            <span className={`badge ${summary.conservation.conserved ? "badge-success" : "badge-refused"}`}>
              {summary.conservation.conserved ? "Yes" : "No"}
            </span>
          </td></tr>
        </tbody>
      </table>
      {summary.violations.length > 0 && (
        <>
          <h3>Violations</h3>
          <ul style={{ maxWidth: "100%", overflow: "auto" }}>
            {summary.violations.map((v, i) => (
              <li key={i} className="mono" style={{ fontSize: "0.875rem" }}>{v}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
