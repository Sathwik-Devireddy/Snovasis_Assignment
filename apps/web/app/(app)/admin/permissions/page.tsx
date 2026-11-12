/**
 * Admin: Permission management page (PHASE-10 P11.3).
 *
 * POST /account-permissions — grant; DELETE /account-permissions — revoke.
 */

"use client";

import { apiPost } from "@/lib/api";
import { useState } from "react";

export default function AdminPermissionsPage() {
  const [userId, setUserId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [permission, setPermission] = useState("VIEW");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await apiPost("/account-permissions", { userId, accountId, permission }, `perm_${crypto.randomUUID()}`);
      setSuccess("Permission granted.");
      setUserId("");
      setAccountId("");
    } catch (err) {
      setError(`Failed: ${(err as { code?: string }).code ?? "UNKNOWN"}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Admin: Grant Permission</h2>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 500 }}>
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
        <button type="submit" disabled={loading}>
          {loading ? "Granting…" : "Grant Permission"}
        </button>
      </form>
      <p style={{ fontSize: "0.875rem", color: "#666" }}>
        Revocation is not exposed through the UI in v1 — use the API directly
        (DELETE /account-permissions).
      </p>
    </div>
  );
}
