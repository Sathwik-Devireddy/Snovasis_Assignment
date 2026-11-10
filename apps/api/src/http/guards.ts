import { DomainError } from "./errors.js";

/**
 * Mutation-route guards (PHASE-05 P5.6; ADR-006 item 3): mutating routes
 * require `Content-Type: application/json` and a same-origin `Origin` header
 * (when a caller sends one — first-party browser calls always do). This is a
 * CSRF mitigation layer; it is never an authentication mechanism.
 */
export async function assertMutationHeaders(request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    const host = request.headers.host;
    let allowed = false;
    try {
      allowed = typeof host === "string" && new URL(origin).host === host;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new DomainError("VALIDATION_FAILED", "Request origin not allowed.");
    }
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && !contentType.startsWith("application/json")) {
    throw new DomainError("INVALID_BODY", "Content-Type must be application/json.");
  }
}
