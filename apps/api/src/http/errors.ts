/**
 * Error taxonomy + external envelope mapping (PHASE-04 P4.4; REFUSAL_CODES Rev 4,
 * API_CONTRACT "Suggested error taxonomy").
 *
 * Two-sided truth rule (REFUSAL_CODES §0): the external envelope never reveals
 * more than the caller is entitled to; internal truth (`transaction_attempts`)
 * keeps exact reasons. The mapper is the single place codes→HTTP mapping lives.
 * Phase 5+ route handlers throw `DomainError` and get this mapping uniformly.
 */

export type ErrorCode =
  // transport / validation (400 / 401 / 429)
  | "VALIDATION_FAILED"
  | "INVALID_BODY"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  // authorisation refusals (uniform 404 per REFUSAL_CODES §3)
  | "ACCOUNT_NOT_FOUND"
  // business refusals (409)
  | "INVALID_AMOUNT"
  | "CURRENCY_MISMATCH"
  | "INSUFFICIENT_FUNDS"
  | "KEY_MISMATCH"
  | "KEY_REUSED"
  | "ACCOUNT_NOT_ACTIVE"
  | "LAST_ADMIN_PROTECTED"
  | "NONZERO_BALANCE"
  // infrastructure failures (500 / 503) — retry-safe, key NOT consumed
  | "LOCK_TIMEOUT"
  | "INFRA_FAILURE";

const httpByCode: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_BODY: 400,
  UNAUTHENTICATED: 401,
  RATE_LIMITED: 429,
  ACCOUNT_NOT_FOUND: 404,
  INVALID_AMOUNT: 409,
  CURRENCY_MISMATCH: 409,
  INSUFFICIENT_FUNDS: 409,
  KEY_MISMATCH: 409,
  KEY_REUSED: 409,
  ACCOUNT_NOT_ACTIVE: 409,
  LAST_ADMIN_PROTECTED: 409,
  NONZERO_BALANCE: 409,
  LOCK_TIMEOUT: 503,
  INFRA_FAILURE: 500,
};

export const statusCodeFor = (code: ErrorCode): number => httpByCode[code];

export class DomainError extends Error {
  readonly code: ErrorCode;
  /** Truthful internal detail for audit rows only — NEVER serialised to callers. */
  readonly internalDetail?: string;

  constructor(code: ErrorCode, message: string, internalDetail?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.internalDetail = internalDetail;
  }
}

/** Uniform external envelope: never includes internal detail. */
export function errorEnvelope(code: ErrorCode, message: string): {
  statusCode: number;
  body: { error: { code: ErrorCode; message: string } };
} {
  return {
    statusCode: statusCodeFor(code),
    body: { error: { code, message } },
  };
}
