/**
 * CSRF origin policy for mutating routes (ADR-006 item 3).
 *
 * WHY THIS EXISTS (and why the naive host check broke):
 * the browser sends `Origin: <app origin>` on same-origin mutations. When the
 * frontend calls the API through the Next.js `/api/*` rewrite, that rewrite
 * runs an internal HTTP proxy with `changeOrigin: true`, so the upstream
 * `Host` header is rewritten to the API origin while the browser's `Host`
 * survives in `x-forwarded-host`. Comparing `Origin` against `Host` therefore
 * never matches in the deployed topology and rejected EVERY browser mutation
 * with 400 "Request origin not allowed.".
 *
 * POLICY (defence in depth, never an authentication mechanism):
 *   1. No `Origin` header at all (non-browser clients, server-to-server) is
 *      allowed — unchanged behaviour; the session cookie + CSRF-safe
 *      SameSite policy remain the real defences.
 *   2. An explicit allow-list (`APP_ORIGIN`, comma-separated origins) is the
 *      production mechanism and is REQUIRED in production (config.ts refuses
 *      to boot without it). A browser origin is accepted only if it is on the
 *      list.
 *   3. A request whose `Origin` matches the API's own `Host` (direct
 *      same-origin call, no proxy) is always accepted.
 *   4. ONLY when no allow-list is configured (development/test) may the
 *      original proxied host (`x-forwarded-host`) satisfy the check. This
 *      keeps the local frontend→API topology working without ever trusting a
 *      client-supplied forwarded header in production.
 */

/** Normalise an origin string to `scheme://host[:port]`, or null if invalid. */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/** Parse the `APP_ORIGIN` allow-list (comma-separated) into normalised origins. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const normalized = normalizeOrigin(part);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

export type OriginCheckInput = {
  origin: string | undefined;
  host: string | undefined;
  forwardedHost: string | undefined;
  allowedOrigins: string[];
};

/**
 * Decide whether a mutation's `Origin` may proceed. Returns false when the
 * origin is malformed, foreign, or cannot be matched.
 */
export function isOriginAllowed(input: OriginCheckInput): boolean {
  const origin = normalizeOrigin(input.origin);
  if (origin === null) return false;
  // Host[:port] of the calling origin — scheme-independent, because the
  // browser may use https while the Host header carries no scheme.
  const originHost = new URL(origin).host;

  // (2) Explicit allow-list — the production mechanism.
  if (input.allowedOrigins.length > 0) {
    if (input.allowedOrigins.includes(origin)) return true;
  } else {
    // (4) Development/test only: accept the original browser host preserved
    // by the frontend's rewrite proxy.
    const forwarded = input.forwardedHost?.trim();
    if (forwarded !== undefined && forwarded.length > 0 && forwarded === originHost) {
      return true;
    }
  }

  // (3) Direct same-origin call to the API itself is always acceptable.
  const host = input.host?.trim();
  if (host !== undefined && host.length > 0 && host === originHost) return true;

  return false;
}
