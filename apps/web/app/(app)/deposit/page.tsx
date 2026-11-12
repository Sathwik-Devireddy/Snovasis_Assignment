/**
 * Deposit page (PHASE-10 P11.3 — H-2: ADMIN only).
 *
 * POST /accounts/:accountId/deposits — ADMIN cash desk. Holders have no
 * deposit path; this form can only fail for them.
 */

"use client";

import { apiPost } from "@/lib/api";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useEffect, useState } from "react";

type DepositResponse = { status: string; journalTransactionId: string; replayed: boolean };

type State = "idle" | "pending" | "success" | "refused" | "unknown";

export default function DepositPage() {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<DepositResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIdempotencyKey(`dep_${crypto.randomUUID()}`);
  }, []);

  /** P11.5: string parsing in lib/money.ts — no floats, exact BigInt paise. */
  function amountMinor(): string {
    return parseAmountToPaise(amount);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setResult(null);

    let parsed: string;
    try {
      parsed = amountMinor();
    } catch (err) {
      setState("refused");
      setError(err instanceof MoneyParseError ? err.message : "Invalid amount.");
      return;
    }

    setLoading(true);
    try {
      const res = await apiPost(`/accounts/${accountId}/deposits`, {
        amountMinor: parsed,
        currencyCode: "INR",
      }, idempotencyKey);

      const data = res as DepositResponse;
      setResult(data);
      setState(data.status === "SUCCEEDED" ? "success" : "refused");
    } catch (err) {
      const e = err as { statusCode?: number; code?: string };
      if (e.statusCode === 408) {
        setState("unknown");
        setError("Request timed out. Retry with the same idempotency key.");
      } else {
        setState("refused");
        setError(`Refused: ${e.code ?? "REFUSED"}`);
      }
    } finally {
      setLoading(false);
    }
  }

  function retry() {
    setError("");
    setResult(null);
    setState("pending");
    setLoading(true);
    void apiPost(`/accounts/${accountId}/deposits`, {
      amountMinor: amountMinor(),
      currencyCode: "INR",
    }, idempotencyKey)
      .then((res) => {
        const data = res as DepositResponse;
        setResult(data);
        setState(data.status === "SUCCEEDED" ? "success" : "refused");
      })
      .catch((err) => {
        setState("refused");
        setError(`Refused: ${(err as { code?: string }).code ?? "REFUSED"}`);
      })
      .finally(() => setLoading(false));
  }

  function newIntent() {
    setIdempotencyKey(`dep_${crypto.randomUUID()}`);
    setState("idle");
    setError("");
    setResult(null);
  }

  return (
    <div className="card">
      <h2>Deposit (Admin Cash Desk)</h2>
      <p style={{ fontSize: "0.875rem", color: "#666" }}>
        H-2: Deposits are admin-only. Holders have no deposit path.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 400 }}>
        <label>
          Account ID <input required type="text" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        </label>
        <label>
          Amount (INR)
          <input required type="text" placeholder="e.g. 100.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span style={{ fontSize: "0.75rem", color: "#666" }}>String input → integer paise server-side.</span>
        </label>
        <button type="submit" disabled={loading || state === "pending"}>
          {loading ? "Sending…" : "Deposit"}
        </button>
      </form>

      <p className="mono">Idempotency key: {idempotencyKey}</p>

      {state === "success" && (
        <div className="success">
          Deposit succeeded. Journal:{" "}
          <span className="mono">{result?.journalTransactionId}</span>{result?.replayed ? " (replayed)" : ""}
        </div>
      )}
      {state === "refused" && <div className="error">{error}</div>}
      {state === "unknown" && (
        <div className="error badge-unknown">
          Request timed out. Retry with the same key to check.
        </div>
      )}

      {(state === "success" || state === "refused" || state === "unknown") && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button onClick={newIntent} disabled={loading}>New Intent</button>
          {state === "unknown" && <button onClick={retry} disabled={loading}>Retry (same key)</button>}
        </div>
      )}
    </div>
  );
}
