"use client";

/**
 * Accounts list page (PHASE-11 P11.3).
 *
 * GET /accounts — holders see only VIEW-granted accounts; ADMIN/AUDITOR see
 * all. Money values rendered as strings, exactly as received (T-049).
 *
 * Client-side fetch: the session cookie is browser-scoped, so account data
 * must load from the browser (a server component would have neither the
 * cookie nor an absolute API URL).
 */

import { apiGet } from "@/lib/api";
import { useEffect, useState } from "react";

type Account = {
  id: string;
  account_number: string;
  label: string;
  currency_code: string;
  kind: string;
  status: string;
  balance_minor: string | null;
  event_last_seq: string | null;
};

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiGet("/accounts")
      .then((data) => {
        if (cancelled) return;
        setAccounts((data as { accounts?: Account[] }).accounts ?? []);
      })
      .catch((err: { statusCode?: number }) => {
        if (cancelled) return;
        setError(
          err.statusCode === 404 || err.statusCode === 403
            ? "You do not have permission to view any accounts."
            : "Failed to load accounts.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="card"><p>Loading accounts…</p></div>;

  return (
    <div className="card">
      <h2>Accounts</h2>
      {error && <div className="error">{error}</div>}
      {accounts?.length === 0 && !error && <p>No accounts visible.</p>}
      {accounts && accounts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Label</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Balance</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.id}</td>
                <td>{a.label}</td>
                <td>{a.kind}</td>
                <td>{a.status}</td>
                <td className="mono">{a.balance_minor ?? "—"} {a.currency_code}</td>
                <td>
                  <a href={`/accounts/${a.id}`}>Detail</a>{" "}
                  <a href={`/accounts/${a.id}/statement`}>Statement</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
