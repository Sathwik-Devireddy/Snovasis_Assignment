"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Session guard for every protected page (frontend quality pass).
 *
 * The (app) layout renders this once; on mount it resolves the session the
 * same way the API does (GET /me through the same-origin proxy). A
 * DEFINITIVE 401 (no/expired/revoked session, disabled user) redirects to
 * /login instead of leaving a logged-out visitor facing a form that can only
 * fail on submit. A network failure does NOT redirect — the page-level error
 * handling speaks for that, and an offline visitor must not lose their place.
 *
 * This is convenience, never enforcement: the API re-derives the session for
 * every call and refuses everything unauthorised (deny-by-default).
 */
export default function SessionGuard() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!cancelled && res.status === 401) {
          router.replace("/login");
        }
      } catch {
        // Network trouble is not a session verdict.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
