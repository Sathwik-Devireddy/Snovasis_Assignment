/**
 * Admin: User management page (PHASE-10 P11.3).
 *
 * POST /users — admin-only user creation.
 */

"use client";

import { apiPost } from "@/lib/api";
import { useState } from "react";

export default function AdminAccountsPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("ACCOUNT_HOLDER");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await apiPost("/users", { email, password, role }, `user_${crypto.randomUUID()}`);
      setSuccess("User created.");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(`Failed: ${(err as { code?: string }).code ?? "UNKNOWN"}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Admin: Create User</h2>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 400 }}>
        <label>
          Email <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password <input required type="password" minLength={16} value={password} onChange={(e) => setPassword(e.target.value)} />
          <span style={{ fontSize: "0.75rem", color: "#666" }}>Min 16 characters.</span>
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "ACCOUNT_HOLDER" | "AUDITOR")}>
            <option value="ACCOUNT_HOLDER">Account Holder</option>
            <option value="ADMIN">Admin</option>
            <option value="AUDITOR">Auditor</option>
          </select>
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create User"}
        </button>
      </form>
    </div>
  );
}
