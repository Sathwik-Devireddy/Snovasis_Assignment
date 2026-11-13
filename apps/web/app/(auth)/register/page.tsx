"use client";

import React from "react";

/**
 * Registration page (frontend quality pass).
 *
 * POST /register — holder onboarding. The role is ALWAYS the server-side
 * constant ACCOUNT_HOLDER: no field in this (or any) request can create an
 * ADMIN or AUDITOR (REG-001; the strict API schema refuses the attempt).
 * Every invalid registration — weak password, duplicate email, malformed
 * body — returns the SAME uniform envelope (REG-002), so the page reports
 * the refusal honestly without claiming to know which rule fired.
 */

const PASSWORD_HINT = "At least 10 characters.";

export default function RegisterPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { user?: { email?: string } };
      if (!res.ok) {
        setError("Registration failed — the email may already be registered, or the details are invalid.");
        return;
      }
      setSuccess(`Account created for ${body.user?.email ?? email}. You can sign in now.`);
      setEmail("");
      setPassword("");
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", maxWidth: 400 }}>
      <h1>BalanceVault</h1>
      <h2>Create an account</h2>
      {/* One live region announces every outcome of this form. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {error && <p style={{ color: "#b00020" }}>{error}</p>}
        {success && <p style={{ color: "#0a7d33" }}>{success}</p>}
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          Email <input name="email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password <input name="password" required type="password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          <span style={{ display: "block", fontSize: "0.75rem", color: "#666" }}>{PASSWORD_HINT}</span>
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>
      <p style={{ fontSize: "0.9rem", color: "#666" }}>
        A new account starts as an ACCOUNT_HOLDER with no accounts and no
        permissions — an administrator grants access. Already registered?{" "}
        <a href="/login">Sign in</a>.
      </p>
    </main>
  );
}
