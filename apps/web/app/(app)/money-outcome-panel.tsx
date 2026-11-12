/**
 * Shared outcome panel for the money pages (master-stabilisation 4.3 + Stage C).
 *
 * One live region announces every financial outcome (success, refusal,
 * retryable failure, unknown outcome, expired session) — screen-reader users
 * are told when money moved and when it did NOT.
 *
 * State semantics:
 *   succeeded       — the API confirmed the transaction (journal id shown).
 *   refused         — CONFIRMED refusal: the server processed the request and
 *                     did not move money.
 *   retry_later     — nothing was processed (rate limited); retry the SAME key.
 *   unknown         — the outcome is NOT known; retry the SAME key to find out.
 *   session_expired — the session is gone; sign in again (nothing processed).
 */

"use client";

import Link from "next/link";
import type { MoneyOperationState } from "@/lib/use-money-operation";

export type MoneyOutcomePanelProps = {
  state: MoneyOperationState;
  message: string;
  pending: boolean;
  onRetry: () => void;
  onNewIntent: () => void;
};

export function MoneyOutcomePanel({
  state,
  message,
  pending,
  onRetry,
  onNewIntent,
}: MoneyOutcomePanelProps) {
  const showActions =
    state === "succeeded" ||
    state === "refused" ||
    state === "invalid" ||
    state === "retry_later" ||
    state === "unknown";
  const showRetry = state === "unknown" || state === "retry_later";

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* Single live region: every outcome change is announced. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {state === "succeeded" && <div className="success">{message}</div>}
        {state === "refused" && <div className="error">{message}</div>}
        {state === "invalid" && <div className="error">{message}</div>}
        {state === "retry_later" && <div className="error">{message}</div>}
        {state === "unknown" && <div className="error badge-unknown">{message}</div>}
        {state === "session_expired" && (
          <div className="error">
            {message} <Link href="/login">Sign in again</Link>
          </div>
        )}
        {state === "pending" && <div className="muted">Submitting — waiting for the server…</div>}
      </div>

      {showActions && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button onClick={onNewIntent} disabled={pending}>
            New Intent
          </button>
          {showRetry && (
            <button onClick={onRetry} disabled={pending}>
              Retry (same key)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
