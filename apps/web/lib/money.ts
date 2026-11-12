/**
 * Money parsing for form inputs (PHASE-11 P11.5).
 *
 * Converts a rupees string (e.g. "50.00") to integer paise using string
 * arithmetic only — never binary floating point. This is a UI usability
 * helper: the server re-validates every amount against the raw JSON token
 * (T-049/T-023) and remains the sole financial authority.
 *
 * Rules:
 * - Accepts only plain decimal rupees: digits, optionally one decimal point
 *   with 1–2 digits (`50`, `50.0`, `50.00`).
 * - Rejects negatives, empty input, exponent notation and anything with more
 *   than 2 decimal places — a fractional paise is NEVER silently rounded or
 *   truncated away (money integrity: rounding is a financial decision).
 * - Returns a decimal string, safe for BigInt-scale amounts (beyond 2^53).
 */

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

/** Strict rupees grammar: `123`, `123.4`, `123.45` (no sign, no exponent). */
const RUPEES_PATTERN = /^\d+(\.\d{1,2})?$/;

export function parseAmountToPaise(rupees: string): string {
  const trimmed = rupees.trim();
  if (!RUPEES_PATTERN.test(trimmed)) {
    throw new MoneyParseError(
      `Invalid amount "${rupees}" — enter rupees with up to 2 decimals, e.g. "50.00".`,
    );
  }
  const [rupeesPart, paisePart = ""] = trimmed.split(".");
  const paise = paisePart.padEnd(2, "0");
  return (BigInt(rupeesPart) * 100n + BigInt(paise)).toString();
}
