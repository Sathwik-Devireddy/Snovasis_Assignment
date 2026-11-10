import { describe, it, expect } from "vitest";
import { DomainError, statusCodeFor } from "../../src/http/errors.js";
import { mapToErrorResponse } from "../../src/http/errorMapper.js";

describe("error mapper (PHASE-04 P4.4)", () => {
  it.each([
    ["VALIDATION_FAILED", 400],
    ["UNAUTHENTICATED", 401],
    ["ACCOUNT_NOT_FOUND", 404],
    ["RATE_LIMITED", 429],
    ["INVALID_AMOUNT", 409],
    ["KEY_REUSED", 409],
    ["ACCOUNT_NOT_ACTIVE", 409],
    ["LAST_ADMIN_PROTECTED", 409],
    ["NONZERO_BALANCE", 409],
    ["LOCK_TIMEOUT", 503],
    ["INFRA_FAILURE", 500],
  ] as const)("maps %s → HTTP %i", (code, status) => {
    expect(statusCodeFor(code)).toBe(status);
  });

  it("maps DomainError to its envelope with no internal detail leaked", () => {
    const err = new DomainError("INSUFFICIENT_FUNDS", "Business refusal 409.", "internal-truth");
    const mapped = mapToErrorResponse(err);
    expect(mapped.statusCode).toBe(409);
    expect(mapped.body.error).toEqual({
      code: "INSUFFICIENT_FUNDS",
      message: "Business refusal 409.",
    });
    expect(JSON.stringify(mapped.body)).not.toContain("internal-truth");
  });

  it("maps unknown errors to INFRA_FAILURE without leaking stack internals", () => {
    const mapped = mapToErrorResponse(new Error("pg: secret table names in message"));
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe("INFRA_FAILURE");
    expect(mapped.body.error.message).toBe("Internal infrastructure failure.");
    expect(JSON.stringify(mapped)).not.toContain("pg:");
  });
});
