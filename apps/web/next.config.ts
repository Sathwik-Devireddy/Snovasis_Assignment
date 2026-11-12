import type { NextConfig } from "next";

/**
 * API origin for browser-facing /api/* rewrites (P4.8; master-stabilisation
 * 4.1). In production the frontend and backend may deploy as separate
 * services, so the internal origin comes from the server-side env var
 * API_INTERNAL_URL (never NEXT_PUBLIC_* — the internal service address must
 * not leak to the browser; browser requests always go through the same-origin
 * /api path).
 *
 * - Development: defaults to http://localhost:4000 (docker-compose maps the
 *   API on the host at 4000).
 * - Production: API_INTERNAL_URL is REQUIRED — a missing or malformed value
 *   fails the build/startup with a clear error instead of silently proxying
 *   production traffic to localhost.
 */
function resolveApiInternalUrl(): string {
  const raw = process.env.API_INTERNAL_URL;
  if (raw === undefined || raw === "") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "API_INTERNAL_URL is required in production: set it to the internal API origin, e.g. http://api:4000",
      );
    }
    return "http://localhost:4000";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`API_INTERNAL_URL is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`API_INTERNAL_URL must be an http(s) URL, got: "${raw}"`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`API_INTERNAL_URL must not include a path, got: "${raw}"`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`API_INTERNAL_URL must not include a query or fragment, got: "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

const apiInternalUrl = resolveApiInternalUrl();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
