import { describe, it, expect } from "vitest";

import { ApiErrorResponse, classifyMoneyError } from "./api";

/**
 * Money error classification tests (master-stabilisation 4.3).
 *
 * The backend maps LOCK_TIMEOUT → 503. The frontend previously handled only
 * HTTP 408 as an unknown outcome, so a 503 LOCK_TIMEOUT was displayed as a
 * confirmed refusal even though the financial outcome was NOT known. These
 * tests pin the classifier: unknown-outcome errors must be retry-safe with
 * the SAME key and must never be worded as a definite failure.
 */
describe("classifyMoneyError (master-stabilisation 4.3)", () => {
  it("classifies 503 LOCK_TIMEOUT as unknown + retry-same-key", () => {
    const c = classifyMoneyError(new ApiErrorResponse(503, "LOCK_TIMEOUT", "LOCK_TIMEOUT"));
    expect(c.kind).toBe("unknown");
    expect(c.retrySameKey).toBe(true);
    expect(c.message).toMatch(/same idempotency key/i);
  });

  it("classifies HTTP 408 as unknown + retry-same-key", () => {
    const c = classifyMoneyError(new ApiErrorResponse(408, "REQUEST_TIMEOUT", "timeout"));
    expect(c.kind).toBe("unknown");
    expect(c.retrySameKey).toBe(true);
  });

  it("classifies any other 5xx as unknown + retry-same-key (commit-then-lost-response)", () => {
    const c = classifyMoneyError(new ApiErrorResponse(500, "INFRA_FAILURE", "boom"));
    expect(c.kind).toBe("unknown");
    expect(c.retrySameKey).toBe(true);
  });

  it("classifies a network failure (non-API error) as unknown + retry-same-key", () => {
    // fetch() throws a TypeError on network failure — not an ApiErrorResponse.
    const c = classifyMoneyError(new TypeError("Failed to fetch"));
    expect(c.kind).toBe("unknown");
    expect(c.retrySameKey).toBe(true);
    expect(c.code).toBe("NETWORK_ERROR");
  });

  it("classifies 409 as a confirmed business refusal (not retryable)", () => {
    const c = classifyMoneyError(new ApiErrorResponse(409, "INSUFFICIENT_FUNDS", "no"));
    expect(c.kind).toBe("refused");
    expect(c.retrySameKey).toBe(false);
    expect(c.message).toContain("INSUFFICIENT_FUNDS");
  });

  it("classifies 404 (uniform authorization denial) as a confirmed refusal", () => {
    const c = classifyMoneyError(new ApiErrorResponse(404, "ACCOUNT_NOT_FOUND", "Not found."));
    expect(c.kind).toBe("refused");
    expect(c.retrySameKey).toBe(false);
  });

  it("classifies 400 as a permanent validation failure (not retryable)", () => {
    const c = classifyMoneyError(
      new ApiErrorResponse(400, "VALIDATION_FAILED", "invalid amount_minor"),
    );
    expect(c.kind).toBe("invalid");
    expect(c.retrySameKey).toBe(false);
  });

  it("classifies 401 as an expired session (sign-in message, no retry button)", () => {
    const c = classifyMoneyError(
      new ApiErrorResponse(401, "UNAUTHENTICATED", "Authentication required."),
    );
    expect(c.kind).toBe("session_expired");
    expect(c.retrySameKey).toBe(false);
    expect(c.message).toMatch(/sign in again/i);
  });

  it("classifies 429 as retry-later with the same key", () => {
    const c = classifyMoneyError(new ApiErrorResponse(429, "RATE_LIMITED", "slow down"));
    expect(c.kind).toBe("retry_later");
    expect(c.retrySameKey).toBe(true);
    expect(c.message).toMatch(/same idempotency key/i);
  });

  it("unknown-outcome wording never claims the transaction failed", () => {
    for (const err of [
      new ApiErrorResponse(503, "LOCK_TIMEOUT", "LOCK_TIMEOUT"),
      new ApiErrorResponse(408, "REQUEST_TIMEOUT", "timeout"),
      new ApiErrorResponse(500, "INFRA_FAILURE", "boom"),
      new TypeError("Failed to fetch"),
    ]) {
      const c = classifyMoneyError(err);
      expect(c.message).not.toMatch(/^Refused/i);
      expect(c.message).toMatch(/outcome is not known|may or may not have been processed/i);
    }
  });
});
