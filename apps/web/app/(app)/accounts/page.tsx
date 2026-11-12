/**
 * Accounts list page (PHASE-10 P11.3).
 *
 * GET /accounts — holders see only VIEW-granted accounts; ADMIN/AUDITOR see
 * all. Money values rendered as strings (T-049).
 */

import { apiGet } from "@/lib/api";

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

export default async function AccountsPage() {
  let accounts: Account[] = [];
  let error = "";

  try {
    const data = (await apiGet("/accounts")) as { accounts: Account[] };
    accounts = data.accounts ?? [];
  } catch (err) {
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 404) {
      error = "You do not have permission to view any accounts.";
    } else {
      error = "Failed to load accounts.";
    }
  }

  return (
    <div className="card">
      <h2>Accounts</h2>
      {error && <div className="error">{error}</div>}
      {accounts.length === 0 && !error && <p>No accounts visible.</p>}
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Label</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Balance</th>
            <th>Events</th>
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
              <td className="mono">{a.event_last_seq ?? "—"}</td>
              <td>
                <a href={`/app/accounts/${a.id}`}>Detail</a>{" "}
                <a href={`/app/accounts/${a.id}/statement`}>Statement</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
