import { DomainError, errorEnvelope } from "./errors.js";
import type { ErrorCode } from "./errors.js";

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
  // Fastify client errors (status-coded, e.g. empty JSON body) keep their
  // status code; nothing else leaks.
  if (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode: number }).statusCode === "number"
  ) {
    const code = fastifyStatusToCode[(error as { statusCode: number }).statusCode];
    if (code) {
      return errorEnvelope(code, "Request could not be completed.");
    }
  }
  // Unexpected → infrastructure failure; never leak internals to the caller.
  return errorEnvelope("INFRA_FAILURE", "Internal infrastructure failure.");
}

export const fastifyStatusToCode: Record<number, ErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "ACCOUNT_NOT_FOUND",
  404: "ACCOUNT_NOT_FOUND",
  429: "RATE_LIMITED",
  503: "LOCK_TIMEOUT",
};
