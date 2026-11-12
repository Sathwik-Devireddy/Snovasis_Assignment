import { describe, it, expect } from "vitest";
import { isInt64Token } from "../../src/domain/money.js";
import { isStatementTimeoutCancellation } from "../../src/domain/transactionRunner.js";

/**
 * BIGINT boundary validation tests (master-stabilisation 5.3).
 *
 * Public ids cross the API as decimal strings. A bare `\d{1,19}` regex accepts
 * values above PostgreSQL's signed BIGINT maximum, which then fails in the
 * database with SQLSTATE 22003 → accidental 500. isInt64Token must reject
 * those tokens at the transport boundary.
 */
describe("isInt64Token (master-stabilisation 5.3)", () => {
  it("accepts the maximum valid signed BIGINT", () => {
    expect(isInt64Token("9223372036854775807")).toBe(true);
  });

  it("accepts small and zero values", () => {
    expect(isInt64Token("0")).toBe(true);
    expect(isInt64Token("1")).toBe(true);
    expect(isInt64Token("123")).toBe(true);
  });

  it("accepts leading zeros within range", () => {
    expect(isInt64Token("007")).toBe(true);
    expect(isInt64Token("0000000000000000001")).toBe(true);
  });

  it("rejects maximum-plus-one (the 22003 trigger)", () => {
    expect(isInt64Token("9223372036854775808")).toBe(false);
  });

  it("rejects very large values", () => {
    expect(isInt64Token("9999999999999999999")).toBe(false);
  });

  it("rejects non-numeric and malformed tokens", () => {
    expect(isInt64Token("")).toBe(false);
    expect(isInt64Token("abc")).toBe(false);
    expect(isInt64Token("12.5")).toBe(false);
    expect(isInt64Token("-1")).toBe(false);
    expect(isInt64Token("1e5")).toBe(false);
    expect(isInt64Token(" 1")).toBe(false);
  });

  it("rejects 20-digit tokens even if within range digits", () => {
    expect(isInt64Token("92233720368547758070")).toBe(false);
  });
});

/**
 * SQLSTATE 57014 classification tests (master-stabilisation 5.1).
 *
 * 57014 is query_canceled — broader than statement timeout. It must count as
 * a retry-safe LOCK_TIMEOUT only when the driver message says the statement
 * was canceled due to statement timeout; a genuine user/client cancellation
 * must NOT be labeled retry-safe.
 */
describe("isStatementTimeoutCancellation (master-stabilisation 5.1)", () => {
  it("recognizes the PostgreSQL statement_timeout driver message", () => {
    const error = new Error("canceling statement due to statement timeout");
    (error as { code?: string }).code = "57014";
    expect(isStatementTimeoutCancellation(error)).toBe(true);
  });

  it("rejects user-request cancellation (same SQLSTATE, different cause)", () => {
    const error = new Error("canceling statement due to user request");
    (error as { code?: string }).code = "57014";
    expect(isStatementTimeoutCancellation(error)).toBe(false);
  });

  it("rejects unrelated 57014 messages", () => {
    const error = new Error("connection terminated unexpectedly");
    (error as { code?: string }).code = "57014";
    expect(isStatementTimeoutCancellation(error)).toBe(false);
  });

  it("rejects string inputs and missing messages", () => {
    expect(isStatementTimeoutCancellation("canceling statement due to statement timeout")).toBe(
      false,
    );
    expect(isStatementTimeoutCancellation(new Error())).toBe(false);
    expect(isStatementTimeoutCancellation(null)).toBe(false);
  });
});
