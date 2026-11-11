/**
 * Money domain (PHASE-06 P6.5; ADR-002).
 *
 * All monetary values are BIGINT minor units (paise). No binary floating-point
 * ever touches money. Two different amount boundaries exist (REFUSAL_CODES §2):
 *
 *   - TRANSPORT boundary (this module's parseMinor): the raw token must be a
 *     decimal integer string inside the signed 64-bit range. Anything else is
 *     a malformed amount_minor token → 400 VALIDATION_FAILED, no attempt row.
 *   - BUSINESS boundary (the runner's pre-lock phase): a grammatically valid
 *     token that is <= 0 or above the per-operation cap → 409 INVALID_AMOUNT,
 *     committed as a replayable refusal on the key row.
 */

import { createHash } from "node:crypto";

/** Minor-unit amount. Always bigint; serialized as decimal strings (T-049). */
export type Minor = bigint;

/** v1 is an INR-only system (REFUSAL_CODES §2; currency_mismatch row). */
export const SYSTEM_CURRENCY = "INR";

/**
 * Per-operation cap (business boundary): 10^15 minor units. Keeps every
 * single posting far below the per-account balance cap so even repeated
 * max-size operations cannot overflow BIGINT sums (ADR-002 D-4;
 * accounts_balance_cap CHECK = 9.2 * 10^18).
 */
export const MAX_PER_OPERATION: Minor = 10n ** 15n;

/** Signed 64-bit bounds (transport boundary). */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Transport-level parse: the client contract sends money as decimal integer
 * STRINGS so JS number precision can never corrupt an amount (T-049).
 * Throws on invalid input → routes map it to 400 VALIDATION_FAILED (no
 * attempt row; nothing durable happened).
 */
export function parseMinor(value: unknown): Minor {
  if (typeof value !== "string") {
    throw new Error(`amount_minor must be a string, got ${typeof value}`);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`amount_minor must be a decimal integer string, got "${value}"`);
  }
  const n = BigInt(value);
  if (n < INT64_MIN || n > INT64_MAX) {
    throw new Error("amount_minor is beyond the signed 64-bit range");
  }
  return n;
}

/** JSON-string-safe decimal form (T-049). */
export function formatMinor(amount: Minor): string {
  return amount.toString();
}

/** Strictly positive (money amounts in journals must be > 0). */
export function isPositive(amount: Minor): boolean {
  return amount > 0n;
}

/**
 * Canonical request hash input (IDEMPOTENCY_BEHAVIORS "Canonical payload"):
 * only the fields the API validated into the command, in a fixed key order,
 * JSON-encoded and SHA-256'd. Raw bodies are never stored or hashed wholesale.
 */
export function canonicalHash(parts: Record<string, string | null>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
}
