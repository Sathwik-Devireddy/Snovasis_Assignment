"use client";

/**
 * Sign-out button (PHASE-11 P11.6).
 *
 * Calls POST /logout so the server REVOKES the session row (T-032: logout
 * revokes) and clears the cookie; falling back to client-side cookie clear
 * alone would leave the session valid if the cookie is stolen.
 */

export default function SignOutButton() {
  return (
    <button
      className="logout"
      onClick={() => {
        void fetch("/api/logout", { method: "POST", credentials: "include" })
          .catch(() => undefined)
          .finally(() => {
            // Best-effort cookie clear even if the API is unreachable.
            document.cookie = "bv_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
            window.location.href = "/login";
          });
      }}
    >
      Sign out
    </button>
  );
}
