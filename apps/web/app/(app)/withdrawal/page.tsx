/**
 * Withdrawal page (PHASE-10 P11.3/P11.4/P11.5).
 *
 * POST /accounts/:accountId/withdrawals — holder with WITHDRAW grant or ADMIN.
 * Idempotency key generated once per form open, kept across retries.
 * Amount parsed as string → integer paise (no floats).
 */

"use client";

import { apiPost } from "@/lib/api";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useEffect, useState } from "react";

type WithdrawalResponse = { status: string; journalTransactionId: string; replayed: boolean };

type State = "idle" | "pending" | "success" | "refused" | "unknown";

export default function WithdrawalPage() {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState(""); // rupees string, e.g. "10.50"
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<WithdrawalResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Generate a new idempotency key when the form mounts (new intent).
  useEffect(() => {
    setIdempotencyKey(`wd_${crypto.randomUUID()}`);
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
      const res = await apiPost(`/accounts/${accountId}/withdrawals`, {
        amountMinor: parsed,
        currencyCode: "INR",
      }, idempotencyKey);

      const data = res as WithdrawalResponse;
      setResult(data);
      if (data.status === "SUCCEEDED") {
        setState("success");
      }
    } catch (err) {
      if (err instanceof Error && (err as { statusCode?: number }).statusCode === 408) {
        // Timeout — unknown state, offer retry with same key
        setState("unknown");
        setError("Request timed out. Retry with the same idempotency key.");
      } else {
        setState("refused");
        const code = (err as { code?: string }).code ?? "REFUSED";
        setError(`Refused: ${code}`);
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
    // Retry with the SAME idempotency key (replay).
    void apiPost(`/accounts/${accountId}/withdrawals`, {
      amountMinor: amountMinor(),
      currencyCode: "INR",
    }, idempotencyKey)
      .then((res) => {
        const data = res as WithdrawalResponse;
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
    setIdempotencyKey(`wd_${crypto.randomUUID()}`);
    setState("idle");
    setError("");
    setResult(null);
  }

  return (
    <div className="card">
      <h2>Withdrawal</h2>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 400 }}>
        <label>
          Account ID <input required type="text" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        </label>
        <label>
          Amount (INR)
          <input
            required
            type="text"
            placeholder="e.g. 10.50"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            // P11.5: string input, no float parsing in UI
          />
          <span style={{ fontSize: "0.75rem", color: "#666" }}>
            Entered as string → converted to integer paise server-side.
          </span>
        </label>
        <button type="submit" disabled={loading || state === "pending"}>
          {loading ? "Sending…" : "Withdraw"}
        </button>
      </form>

      <p className="mono">Idempotency key: {idempotencyKey}</p>

      {state === "success" && (
        <div className="success">
          Withdrawal succeeded. Journal:{" "}
          <span className="mono">{result?.journalTransactionId}</span>{result?.replayed ? " (replayed)" : ""}
        </div>
      )}
      {state === "refused" && (
        <div className="error">{error}</div>
      )}
      {state === "unknown" && (
        <div className="error badge-unknown">
          Request timed out. The result is unknown — retry with the same key
          to check, or start a new intent.
        </div>
      )}

      {(state === "success" || state === "refused" || state === "unknown") && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button onClick={newIntent} disabled={loading}>
            New Intent
          </button>
          {state === "unknown" && (
            <button onClick={retry} disabled={loading}>
              Retry (same key)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
