/**
 * Transfer page (PHASE-10 P11.3).
 *
 * POST /transfers — internal transfer. Requires TRANSFER grant on source.
 * Idempotency key management per P11.4: the key is bound to the exact payload
 * (a retry re-sends the ORIGINAL body with the ORIGINAL key; a changed amount
 * starts a NEW intent with a NEW key).
 */

"use client";

import { MoneyOutcomePanel } from "@/app/(app)/money-outcome-panel";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useMoneyOperation } from "@/lib/use-money-operation";
import { useState } from "react";

export default function TransferPage() {
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [destinationAccountId, setDestinationAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [validationError, setValidationError] = useState("");
  const op = useMoneyOperation("tr");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError("");
    let parsed: string;
    try {
      parsed = parseAmountToPaise(amount);
    } catch (err) {
      setValidationError(err instanceof MoneyParseError ? err.message : "Invalid amount.");
      return;
    }
    await op.submit("/transfers", {
      sourceAccountId,
      destinationAccountId,
      amountMinor: parsed,
      currencyCode: "INR",
    });
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
        <button type="submit" disabled={op.pending}>
          {op.pending ? "Sending…" : "Transfer"}
        </button>
      </form>

      {validationError !== "" && (
        <div className="error" role="alert">
          {validationError}
        </div>
      )}

      <p className="mono">Idempotency key: {op.key}</p>

      <MoneyOutcomePanel
        state={op.state}
        message={op.outcome?.message ?? ""}
        pending={op.pending}
        onRetry={() => void op.retry()}
        onNewIntent={op.newIntent}
      />
    </div>
  );
}
