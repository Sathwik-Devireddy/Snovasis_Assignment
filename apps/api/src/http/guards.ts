import { DomainError } from "./errors.js";
import { isOriginAllowed, parseAllowedOrigins } from "./origins.js";

/**
 * Mutation-route guards (PHASE-05 P5.6; ADR-006 item 3): mutating routes
 * require `Content-Type: application/json` and an acceptable `Origin` header
 * (when a caller sends one — first-party browser calls always do). This is a
 * CSRF mitigation layer; it is never an authentication mechanism.
 *
 * The origin policy itself lives in `origins.ts` (allow-list + proxied-host
 * fallback): the frontend calls the API through the Next.js `/api/*` rewrite,
 * which rewrites the upstream `Host` header, so a plain `Origin === Host`
 * comparison rejects every browser mutation in the deployed topology.
 */
export async function assertMutationHeaders(request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    const headerValue = (name: string): string | undefined => {
      const raw = request.headers[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === "string" ? value : undefined;
    };
    const allowed = isOriginAllowed({
      origin,
      host: headerValue("host"),
      forwardedHost: headerValue("x-forwarded-host"),
      allowedOrigins: parseAllowedOrigins(process.env.APP_ORIGIN),
    });
    if (!allowed) {
      throw new DomainError("VALIDATION_FAILED", "Request origin not allowed.");
    }
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && !contentType.startsWith("application/json")) {
    throw new DomainError("INVALID_BODY", "Content-Type must be application/json.");
  }
}
