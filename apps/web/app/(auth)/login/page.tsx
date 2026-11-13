"use client";

import React from "react";

/**
 * Login page (PHASE-10 P11.3).
 *
 * POST /login — authenticates and sets a session cookie. Uniform 401 for
 * invalid credentials (enumeration resistance). No financial rule in the UI.
 */

export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: { message?: string } })?.error?.message ?? "Login failed.");
        return;
      }
      // Successful login — redirect to dashboard.
      window.location.href = "/accounts";
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", maxWidth: 400 }}>
      <h1>BalanceVault</h1>
      <h2>Sign in</h2>
      {error && <p style={{ color: "#b00020" }}>{error}</p>}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          Email <input name="email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password <input name="password" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p style={{ fontSize: "0.9rem", color: "#666" }}>
        New here? <a href="/register">Create an account</a> — or contact the
        administrator for access to existing accounts.
      </p>
    </main>
  );
}
