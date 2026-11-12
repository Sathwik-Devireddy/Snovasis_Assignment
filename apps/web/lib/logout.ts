/**
 * Logout outcome decision (master-stabilisation 5.4).
 *
 * Server-side revocation is authoritative (T-032). The UI must only redirect
 * to /login after a CONFIRMED successful logout — or after 401, which means
 * the session was already expired/revoked, so there is nothing left to
 * revoke and the user is effectively signed out. Any other outcome (network
 * failure, 5xx) must show a failure state and allow a retry: redirecting
 * would falsely claim the logout succeeded while the session may still be
 * valid.
 *
 * The HttpOnly session cookie is never cleared from JavaScript —
 * document.cookie cannot touch it; only the server's Set-Cookie can.
 */

export type LogoutOutcome = "redirect" | "retry";

export function decideLogoutOutcome(statusCode: number | null): LogoutOutcome {
  if (statusCode === null) return "retry"; // network failure — outcome unknown
  if (statusCode >= 200 && statusCode < 300) return "redirect"; // confirmed revocation
  if (statusCode === 401) return "redirect"; // session already gone — nothing to revoke
  return "retry"; // 5xx / 4xx: revocation NOT confirmed
}

export const LOGOUT_FAILURE_MESSAGE =
  "Sign out failed: the server could not confirm your session was revoked. Please try again.";
