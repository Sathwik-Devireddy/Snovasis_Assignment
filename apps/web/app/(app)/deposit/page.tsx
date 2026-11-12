/**
 * Deposit page (PHASE-10 P11.3 — H-2: ADMIN only).
 *
 * POST /accounts/:accountId/deposits — ADMIN cash desk. Holders have no
 * deposit path; this form can only fail for them.
 *
 * The idempotency key is bound to the exact payload by `useMoneyOperation`:
 * a retry re-sends the ORIGINAL body with the ORIGINAL key, and a changed
 * amount starts a NEW intent with a NEW key (never the same key for a
 * different payload).
 */

"use client";

import { MoneyOutcomePanel } from "@/app/(app)/money-outcome-panel";
import { MoneyParseError, parseAmountToPaise } from "@/lib/money";
import { useMoneyOperation } from "@/lib/use-money-operation";
import { useState } from "react";

export default function DepositPage() {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [validationError, setValidationError] = useState("");
  const op = useMoneyOperation("dep");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError("");
    // P11.5: string parsing in lib/money.ts — no floats, exact BigInt paise.
    // Parsed BEFORE any state transition so a bad amount can never leave the
    // page stuck in "sending".
    let parsed: string;
    try {
      parsed = parseAmountToPaise(amount);
    } catch (err) {
      setValidationError(err instanceof MoneyParseError ? err.message : "Invalid amount.");
      return;
    }
    await op.submit(`/accounts/${accountId}/deposits`, {
      amountMinor: parsed,
      currencyCode: "INR",
    });
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
        <button type="submit" disabled={op.pending}>
          {op.pending ? "Sending…" : "Deposit"}
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
