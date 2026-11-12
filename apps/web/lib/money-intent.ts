/**
 * Money-intent model for the money pages (master-stabilisation 4.3 + Stage C).
 *
 * A financial INTENT is (idempotency key + exact request body + path). The
 * three properties that matter:
 *
 *  1. A RETRY of the same intent must reuse the ORIGINAL key AND the ORIGINAL
 *     body. Rebuilding the body from live form fields after an unknown outcome
 *     would send a DIFFERENT payload under the SAME key: the API answers
 *     409 KEY_REUSED, and the user is shown a "confirmed refusal" for a
 *     transaction that may already have committed — which invites a duplicate
 *     financial effect.
 *  2. A NEW intent (different amount, or a fresh submission after a CONFIRMED
 *     refusal) must carry a NEW key. A key is never reused for a different
 *     payload.
 *  3. After an UNKNOWN outcome the UI must not silently start a second
 *     financial intent; the user has to ask for one explicitly.
 *
 * The helpers here are pure so they can be unit-tested without a DOM.
 */

export type MoneyIntent = {
  /** Idempotency key — sent as the `Idempotency-Key` header. */
  key: string;
  /** API path the intent targets (e.g. `/accounts/12/deposits`). */
  path: string;
  /** Exact request body (already validated, paise as a decimal string). */
  body: Record<string, string>;
};

export type MoneyOutcomeKind =
  | "succeeded"
  | "refused" // confirmed refusal — nothing was processed
  | "invalid" // permanent validation failure — nothing was processed
  | "retry_later" // nothing was processed; retry later with the same key
  | "unknown" // outcome NOT known — retry with the same key to find out
  | "session_expired"; // sign in again; nothing was processed

export type MoneyOutcome = {
  kind: MoneyOutcomeKind;
  message: string;
  /** True when retrying the SAME intent (same key, same body) is meaningful. */
  retrySameKey: boolean;
};

/**
 * Idempotency key generator. `crypto.randomUUID` needs a secure context; a
 * non-HTTPS, non-localhost deployment would leave the key EMPTY (the API then
 * rejects the request with "missing Idempotency-Key"), so fall back to
 * `crypto.getRandomValues`.
 */
export function newIdempotencyKey(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
        ? Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
        : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
  return `${prefix}_${uuid}`;
}

/** Snapshot the current intent (key + path + exact body). */
export function createIntent(key: string, path: string, body: Record<string, string>): MoneyIntent {
  return { key, path, body: { ...body } };
}

/** True when the given path/body still describe the very same intent. */
export function intentMatches(
  intent: MoneyIntent | null,
  path: string,
  body: Record<string, string>,
): boolean {
  if (intent === null) return false;
  if (intent.path !== path) return false;
  const keys = Object.keys(body);
  const intentKeys = Object.keys(intent.body);
  if (keys.length !== intentKeys.length) return false;
  return keys.every((k) => intent.body[k] === body[k]);
}

/**
 * Decide which idempotency key a submission may use.
 *
 * - No previous intent → a brand new key.
 * - Same path + same body → the ORIGINAL key (the API replays the original
 *   result; a double click can never move money twice).
 * - Different body and the previous outcome is known (succeeded / refused) →
 *   a NEW key: this is a genuinely new intent.
 * - Different body while the previous outcome is UNKNOWN → BLOCKED: the money
 *   may already have moved, so a second intent needs an explicit user action
 *   ("New Intent"), never a silent resubmission.
 */
export type IntentDecision =
  { action: "send"; key: string } | { action: "blocked"; message: string };

export function decideIntentKey(
  previous: MoneyIntent | null,
  previousOutcome: MoneyOutcome | null,
  path: string,
  body: Record<string, string>,
  mintKey: () => string,
): IntentDecision {
  if (previous === null) {
    return { action: "send", key: mintKey() };
  }
  if (intentMatches(previous, path, body)) {
    return { action: "send", key: previous.key };
  }
  if (previousOutcome?.kind === "unknown") {
    return {
      action: "blocked",
      message:
        "The previous transaction's outcome is still unknown. Retry it with the same idempotency key, or start a new intent explicitly.",
    };
  }
  return { action: "send", key: mintKey() };
}

/**
 * Classify a 2xx money response.
 *
 * A body that is not the documented envelope is NOT a success and NOT a
 * confirmed refusal — the outcome is simply unknown (the money may have moved
 * and the response was mangled/truncated).
 */
export function classifyMoneyResponse(response: unknown): MoneyOutcome {
  if (typeof response !== "object" || response === null) {
    return {
      kind: "unknown",
      retrySameKey: true,
      message:
        "The server returned an unexpected response — the outcome is not known. Retry with the same idempotency key to check.",
    };
  }
  const status = (response as { status?: unknown }).status;
  if (typeof status !== "string") {
    return {
      kind: "unknown",
      retrySameKey: true,
      message:
        "The server returned an unexpected response — the outcome is not known. Retry with the same idempotency key to check.",
    };
  }
  if (status === "SUCCEEDED") {
    const id = (response as { journalTransactionId?: unknown }).journalTransactionId;
    const replayed = (response as { replayed?: unknown }).replayed === true;
    return {
      kind: "succeeded",
      retrySameKey: false,
      message: `Transaction confirmed. Journal: ${typeof id === "string" ? id : "unknown"}${replayed ? " (replayed)" : ""}.`,
    };
  }
  // A documented non-success status is a CONFIRMED refusal: the server
  // processed the request and decided not to move money.
  return {
    kind: "refused",
    retrySameKey: false,
    message: `Refused by the server: ${status}.`,
  };
}
