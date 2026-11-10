import { DomainError, errorEnvelope } from "./errors.js";

/**
 * Error mapper (PHASE-04 P4.4): the single funnel from thrown errors to the
 * uniform external envelope (API_CONTRACT conventions; REFUSAL_CODES Rev 4).
 * Known business/transport codes map by table; everything unexpected becomes
 * `INFRA_FAILURE` (500) with nothing revealed server-side (detailed stack
 * stays in the server log).
 */

export function mapToErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof DomainError) {
    const envelope = errorEnvelope(error.code, error.message);
    return envelope;
  }
  // Unexpected → infrastructure failure; never leak internals to the caller.
  // (Specific pg SQLSTATE mapping — e.g. 40P01/40P02 → LOCK_TIMEOUT — lands with
  // the DomainTransactionRunner in Phase 6, before any financial route exists.)
  return errorEnvelope("INFRA_FAILURE", "Internal infrastructure failure.");
}

export const knownCodeSummary = { family: "REFUSAL_CODES Rev 4" } as const;
