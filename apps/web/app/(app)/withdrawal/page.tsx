/**
 * Withdrawal page (PHASE-10 P11.3/P11.4/P11.5).
 *
 * POST /accounts/:accountId/withdrawals — holder with WITHDRAW grant or ADMIN.
 * Amount parsed as string → integer paise (no floats). The idempotency key is
 * bound to the exact payload: a retry re-sends the ORIGINAL body with the
 * ORIGINAL key, and a changed amount starts a NEW intent with a NEW key.
 */

"use client";

import { MoneyOutcomePanel } from "@/app/(app)/money-outcome-panel";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useMoneyOperation } from "@/lib/use-money-operation";
import { useState } from "react";

export default function WithdrawalPage() {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState(""); // rupees string, e.g. "10.50"
  const [validationError, setValidationError] = useState("");
  const op = useMoneyOperation("wd");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError("");
    // Parsed BEFORE any state transition (no floats, exact BigInt paise).
    let parsed: string;
    try {
      parsed = parseAmountToPaise(amount);
    } catch (err) {
      setValidationError(err instanceof MoneyParseError ? err.message : "Invalid amount.");
      return;
    }
    await op.submit(`/accounts/${accountId}/withdrawals`, {
      amountMinor: parsed,
      currencyCode: "INR",
    });
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
        <button type="submit" disabled={op.pending}>
          {op.pending ? "Sending…" : "Withdraw"}
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
