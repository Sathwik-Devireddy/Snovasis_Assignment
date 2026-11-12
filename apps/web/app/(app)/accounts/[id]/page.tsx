/**
 * Account detail page (PHASE-10 P11.3).
 *
 * GET /accounts/:id — shows account info. Money values as strings (T-049).
 */

import { apiGet } from "@/lib/api";
import { notFound } from "next/navigation";

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

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let account: Account | null = null;
  let error = "";

  try {
    const data = (await apiGet(`/accounts/${id}`)) as { account: Account };
    account = data.account ?? null;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      notFound();
    }
    error = "Failed to load account.";
  }

  if (!account) return <div className="error">{error}</div>;

  return (
    <div className="card">
      <h2>Account {account.id}</h2>
      <table>
        <tbody>
          <tr><th>Account Number</th><td>{account.account_number}</td></tr>
          <tr><th>Label</th><td>{account.label}</td></tr>
          <tr><th>Kind</th><td>{account.kind}</td></tr>
          <tr><th>Status</th><td>{account.status}</td></tr>
          <tr><th>Currency</th><td>{account.currency_code}</td></tr>
          <tr><th>Balance</th><td className="mono">{account.balance_minor ?? "—"} {account.currency_code}</td></tr>
          <tr><th>Event Counter</th><td className="mono">{account.event_last_seq ?? "—"}</td></tr>
        </tbody>
      </table>
      <p>
        <a href={`/app/accounts/${account.id}/statement`}>View Statement →</a>
      </p>
    </div>
  );
}
