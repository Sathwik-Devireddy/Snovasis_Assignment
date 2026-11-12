/**
 * Admin: Permission management page (PHASE-10 P11.3; frontend quality pass).
 *
 * POST /account-permissions — grant; DELETE /account-permissions — revoke.
 *
 * Revocation is exposed here on purpose: a grant that cannot be withdrawn from
 * the UI is a grant that stays alive after a mistake or an incident. Both
 * operations are audited server-side; the outcome is announced in a live
 * region so the operator knows what happened without reading the screen.
 */

"use client";

import { apiDelete, apiPost } from "@/lib/api";
import { useState } from "react";

export default function AdminPermissionsPage() {
  const [userId, setUserId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [permission, setPermission] = useState("VIEW");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  function friendly(err: unknown): string {
    const code = (err as { code?: string })?.code ?? "UNKNOWN";
    switch (code) {
      case "SELF_GRANT_REFUSED":
        return "An administrator may never grant or revoke a permission on their own account.";
      case "ACCOUNT_NOT_FOUND":
        return "No such user or account (or it is not visible to you).";
      case "VALIDATION_FAILED":
        return "That permission is already granted (or the request was invalid).";
      case "UNAUTHENTICATED":
        return "Your session has expired — please sign in again.";
      default:
        return `The request failed (${code}).`;
    }
  }

  async function run(operation: "grant" | "revoke") {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      if (operation === "grant") {
        await apiPost("/account-permissions", { userId, accountId, permission }, `perm_${crypto.randomUUID()}`);
        setSuccess("Permission granted.");
      } else {
        const result = (await apiDelete("/account-permissions", {
          userId,
          accountId,
          permission,
        })) as { revoked?: boolean };
        setSuccess(
          result?.revoked === true
            ? "Permission revoked."
            : "Nothing to revoke — no active grant matched (the attempt is still audited).",
        );
      }
      setUserId("");
      setAccountId("");
    } catch (err) {
      setError(friendly(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Admin: Permissions</h2>
      {/* One live region announces every outcome of this form. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("grant");
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 500 }}
      >
        <label>
          User ID <input required type="text" value={userId} onChange={(e) => setUserId(e.target.value)} />
        </label>
        <label>
          Account ID <input required type="text" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        </label>
        <label>
          Permission
          <select value={permission} onChange={(e) => setPermission(e.target.value as "VIEW" | "DEPOSIT" | "WITHDRAW" | "TRANSFER" | "ADJUST")}>
            <option value="VIEW">VIEW</option>
            <option value="DEPOSIT">DEPOSIT</option>
            <option value="WITHDRAW">WITHDRAW</option>
            <option value="TRANSFER">TRANSFER</option>
            <option value="ADJUST">ADJUST</option>
          </select>
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" disabled={loading}>
            {loading ? "Working…" : "Grant Permission"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              void run("revoke");
            }}
          >
            Revoke Permission
          </button>
        </div>
      </form>
      <p style={{ fontSize: "0.875rem", color: "#666" }}>
        Both operations are written to the audit trail. Revoking a permission that
        was never granted is an honest no-op — it is still audited.
      </p>
    </div>
  );
}
