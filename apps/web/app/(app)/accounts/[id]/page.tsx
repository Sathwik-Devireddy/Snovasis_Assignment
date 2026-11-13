"use client";

/**
 * Account detail page (PHASE-11 P11.3).
 *
 * GET /accounts/:id — shows account info. Money values as strings, exactly
 * as received (T-049). Client-side fetch (session cookie is browser-scoped).
 */

import { apiGet } from "@/lib/api";
import { balanceLabel, parseAccountRecord, type AccountRecord } from "@/lib/account-view";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [account, setAccount] = useState<AccountRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    apiGet(`/accounts/${id}`)
      .then((data) => {
        if (cancelled) return;
        // Contract-pinned: parseAccountRecord returns null on a shape
        // mismatch (wrong casing/fields), which surfaces as an error instead
        // of a table of undefined values.
        const record = parseAccountRecord((data as { account?: unknown }).account);
        if (record === null) {
          setError("The account response was not in the expected format.");
          return;
        }
        setAccount(record);
      })
      .catch((err: { statusCode?: number }) => {
        if (cancelled) return;
        setError(
          err.statusCode === 404
            ? "Account not found or not visible to you."
            : "Failed to load account.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <div className="card"><p>Loading account…</p></div>;

  if (!account) {
    return (
      <div className="card">
        <div className="error">{error || "Account not found or not visible to you."}</div>
        <p><Link href="/accounts">← Back to accounts</Link></p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Account {account.id}</h2>
      <table>
        <tbody>
          <tr><th>Account Number</th><td>{account.accountNumber}</td></tr>
          <tr><th>Label</th><td>{account.label}</td></tr>
          <tr><th>Kind</th><td>{account.kind}</td></tr>
          <tr><th>Status</th><td>{account.status}</td></tr>
          <tr><th>Currency</th><td>{account.currencyCode}</td></tr>
          <tr><th>Balance</th><td className="mono">{balanceLabel(account)} {account.currencyCode}</td></tr>
          <tr><th>Event Counter</th><td className="mono">{account.eventLastSeq ?? "—"}</td></tr>
        </tbody>
      </table>
      <p>
        <Link href={`/accounts/${account.id}/statement`}>View Statement →</Link>
      </p>
    </div>
  );
}
