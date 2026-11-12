/**
 * Transfer page (PHASE-10 P11.3).
 *
 * POST /transfers — internal transfer. Requires TRANSFER grant on source.
 * Idempotency key management per P11.4.
 */

"use client";

import { apiPost } from "@/lib/api";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useEffect, useState } from "react";

type TransferResponse = { status: string; journalTransactionId: string; replayed: boolean };

type State = "idle" | "pending" | "success" | "refused" | "unknown";

export default function TransferPage() {
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [destinationAccountId, setDestinationAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TransferResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIdempotencyKey(`tr_${crypto.randomUUID()}`);
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
      const res = await apiPost("/transfers", {
        sourceAccountId,
        destinationAccountId,
        amountMinor: parsed,
        currencyCode: "INR",
      }, idempotencyKey);

      const data = res as TransferResponse;
      setResult(data);
      setState(data.status === "SUCCEEDED" ? "success" : "refused");
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 408) {
        setState("unknown");
        setError("Request timed out. Retry with the same idempotency key.");
      } else {
        setState("refused");
        setError(`Refused: ${(err as { code?: string }).code ?? "REFUSED"}`);
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
    void apiPost("/transfers", {
      sourceAccountId,
      destinationAccountId,
      amountMinor: amountMinor(),
      currencyCode: "INR",
    }, idempotencyKey)
      .then((res) => {
        const data = res as TransferResponse;
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
    setIdempotencyKey(`tr_${crypto.randomUUID()}`);
    setState("idle");
    setError("");
    setResult(null);
  }

  return (
    <div className="card">
      <h2>Transfer</h2>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 500 }}>
        <label>
          Source Account ID <input required type="text" value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)} />
        </label>
        <label>
          Destination Account ID <input required type="text" value={destinationAccountId} onChange={(e) => setDestinationAccountId(e.target.value)} />
        </label>
        <label>
          Amount (INR)
          <input required type="text" placeholder="e.g. 50.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span style={{ fontSize: "0.75rem", color: "#666" }}>String input → integer paise server-side.</span>
        </label>
        <button type="submit" disabled={loading || state === "pending"}>
          {loading ? "Sending…" : "Transfer"}
        </button>
      </form>

      <p className="mono">Idempotency key: {idempotencyKey}</p>

      {state === "success" && (
        <div className="success">
          Transfer succeeded. Journal:{" "}
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
