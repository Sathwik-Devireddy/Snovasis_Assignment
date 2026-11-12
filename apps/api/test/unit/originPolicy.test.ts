import { describe, it, expect } from "vitest";
import { isOriginAllowed, normalizeOrigin, parseAllowedOrigins } from "../../src/http/origins.js";

/**
 * CSRF origin policy (master-stabilisation — Stage C finding).
 *
 * The frontend calls the API through the Next.js `/api/*` rewrite, which
 * proxies with `changeOrigin: true`: the upstream `Host` header becomes the
 * API origin while the browser's host survives in `x-forwarded-host`. The old
 * `Origin === Host` comparison therefore rejected EVERY browser mutation
 * (login, logout, deposit, transfer, administration) with 400.
 */

describe("origin normalisation", () => {
  it("accepts http(s) origins and rejects everything else", () => {
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("https://app.example.com")).toBe("https://app.example.com");
    expect(normalizeOrigin("https://app.example.com/some/path")).toBe("https://app.example.com");
    expect(normalizeOrigin("ftp://app.example.com")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it("parses the comma-separated allow-list and drops invalid entries", () => {
    expect(parseAllowedOrigins("http://localhost:3000, https://app.example.com")).toEqual([
      "http://localhost:3000",
      "https://app.example.com",
    ]);
    expect(parseAllowedOrigins("http://localhost:3000, garbage")).toEqual([
      "http://localhost:3000",
    ]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe("origin allow policy", () => {
  it("accepts a proxied browser request (rewritten Host + x-forwarded-host)", () => {
    // What Next's rewrite proxy actually sends upstream.
    expect(
      isOriginAllowed({
        origin: "http://localhost:3000",
        host: "localhost:4000",
        forwardedHost: "localhost:3000",
        allowedOrigins: [],
      }),
    ).toBe(true);
  });

  it("rejects a foreign origin even when a forwarded host is present", () => {
    expect(
      isOriginAllowed({
        origin: "https://evil.example",
        host: "localhost:4000",
        forwardedHost: "localhost:3000",
        allowedOrigins: [],
      }),
    ).toBe(false);
  });

  it("accepts an allow-listed origin regardless of the rewritten Host", () => {
    expect(
      isOriginAllowed({
        origin: "https://app.example.com",
        host: "api.internal:4000",
        forwardedHost: "app.internal",
        allowedOrigins: ["https://app.example.com"],
      }),
    ).toBe(true);
  });

  it("rejects a non-allow-listed origin when an allow-list is configured", () => {
    expect(
      isOriginAllowed({
        origin: "https://evil.example",
        host: "api.internal:4000",
        forwardedHost: "app.internal",
        allowedOrigins: ["https://app.example.com"],
      }),
    ).toBe(false);
  });

  it("never trusts x-forwarded-host once an allow-list is configured", () => {
    // A forged request could claim any forwarded host; with an allow-list in
    // place only the explicit origins are honoured.
    expect(
      isOriginAllowed({
        origin: "https://evil.example",
        host: "api.internal:4000",
        forwardedHost: "evil.example",
        allowedOrigins: ["https://app.example.com"],
      }),
    ).toBe(false);
  });

  it("accepts a direct same-origin call to the API itself", () => {
    expect(
      isOriginAllowed({
        origin: "https://api.example.com",
        host: "api.example.com",
        forwardedHost: undefined,
        allowedOrigins: ["https://app.example.com"],
      }),
    ).toBe(true);
  });

  it("rejects a malformed origin", () => {
    expect(
      isOriginAllowed({
        origin: "://nonsense",
        host: "localhost:4000",
        forwardedHost: "localhost:3000",
        allowedOrigins: [],
      }),
    ).toBe(false);
  });
});
