"use client";

/**
 * Sign-out button (PHASE-11 P11.6; master-stabilisation 5.4).
 *
 * Calls POST /logout so the server REVOKES the session row (T-032: logout
 * revokes) and clears the cookie; a client-side cookie clear alone would
 * leave the session valid if the cookie is stolen.
 *
 * Failure handling: the button redirects ONLY after a confirmed successful
 * revocation (2xx) or a 401 (session already expired/revoked — nothing left
 * to revoke). Network failures and 5xx show a clear failure state with a
 * retry affordance instead of falsely claiming logout succeeded. Repeated
 * submissions are prevented while a request is in flight. Feedback is
 * announced via aria-live. The HttpOnly cookie is never touched from JS.
 */

import { useState } from "react";
import { decideLogoutOutcome, LOGOUT_FAILURE_MESSAGE } from "@/lib/logout";

/** A hung /logout request must not leave the button disabled forever. */
const LOGOUT_TIMEOUT_MS = 10_000;

export default function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  function signOut() {
    if (pending) return; // prevent accidental repeated logout submissions
    setPending(true);
    setFailed(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
    void fetch("/api/logout", {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (decideLogoutOutcome(res.status) === "redirect") {
          window.location.href = "/login";
          return;
        }
        setFailed(true);
        setPending(false);
      })
      .catch(() => {
        // Network failure or timeout — revocation NOT confirmed; never fake
        // success and never leave the button stuck in "Signing out…".
        clearTimeout(timer);
        setFailed(true);
        setPending(false);
      });
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <button className="logout" onClick={signOut} disabled={pending} aria-busy={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      <span role="status" aria-live="polite" style={{ fontSize: "0.75rem", color: "#a33" }}>
        {failed ? LOGOUT_FAILURE_MESSAGE : ""}
      </span>
    </span>
  );
}
