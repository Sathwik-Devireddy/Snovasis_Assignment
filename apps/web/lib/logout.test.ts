import { describe, it, expect } from "vitest";

import { decideLogoutOutcome, LOGOUT_FAILURE_MESSAGE } from "./logout";

/**
 * Logout failure handling tests (master-stabilisation 5.4).
 *
 * The UI must redirect only after a CONFIRMED successful server-side
 * revocation. A 401 means the session was already gone (expired/revoked), so
 * redirecting is correct there too. Everything else — network failure,
 * 5xx — must NOT redirect (that would falsely claim logout succeeded while
 * the session may still be valid); the UI shows a retry state instead.
 */
describe("decideLogoutOutcome (master-stabilisation 5.4)", () => {
  it("redirects after a confirmed successful revocation", () => {
    expect(decideLogoutOutcome(200)).toBe("redirect");
    expect(decideLogoutOutcome(204)).toBe("redirect");
  });

  it("redirects on 401 (session already expired/revoked — nothing to revoke)", () => {
    expect(decideLogoutOutcome(401)).toBe("redirect");
  });

  it("does NOT redirect on network failure (status null)", () => {
    expect(decideLogoutOutcome(null)).toBe("retry");
  });

  it("does NOT redirect on server errors — revocation not confirmed", () => {
    expect(decideLogoutOutcome(500)).toBe("retry");
    expect(decideLogoutOutcome(503)).toBe("retry");
  });

  it("does NOT redirect on unexpected client errors", () => {
    expect(decideLogoutOutcome(400)).toBe("retry");
    expect(decideLogoutOutcome(429)).toBe("retry");
  });

  it("failure message never claims the logout succeeded", () => {
    expect(LOGOUT_FAILURE_MESSAGE).toMatch(/failed/i);
    expect(LOGOUT_FAILURE_MESSAGE).toMatch(/try again/i);
  });
});
