# NON_GOALS.md — Explicit non-goals for v1 (P2.7)

- **Phase:** 2 · **Date:** 2026-11-06 · Agreed so scope arguments end early; revisit only via a human decision + ADR.

| Non-goal | Why out of v1 |
|---|---|
| Overdraft (any form) | H-confirmed: no overdraft in v1; `balance >= 0` enforced server- and DB-side |
| Multi-currency | Only INR, integer minor units; a full currency model is deliberately excluded |
| Interest, fees, holds | Dates, tiers and proration logic are untestable in the window |
| Scheduled/batch/standing payments | New time domains hurt the concurrency analysis |
| Refunds/reversals (as a distinct feature) | Corrections are compensating entries by *policy*, and ADJUSTMENT itself is deferred (H-5) |
| Real bank/payment rails or real customer money | Demo-scale synthetic data only |
| Password change / forgot-password flows | Admin reset outside API; session work stays minimal |
| Microservices, message queues, event sourcing infra, Redis | Modular monolith per architecture doc; nothing to defend beyond it |
| Full RBAC/ABAC engine, permission UI | Straight-through policy code from `AUTHZ_MATRIX.md` is explainable; a generic engine is not |
| JSON/CSV export of statements | Non-essential surface area; statements are API-visible |
| Autonomous AI money movement | Categorically forbidden (AGENTS.md). Optional rule-based anomaly flags are an explicit H-5 feature, never authorised alone |
| Hash chain (SHA-256 per-row chaining) | Recommended stretch, deferred to Phase 15 (D-10 layer 3) — the two-layer controls (roles + triggers) ship first |
| Generic pagination u/i polish beyond demo needs | Polish is deferred; correctness precedes appearance |

Accepted residual risks disclosed instead of solved live: no expiry of idempotency keys (T-017/T-038), database superuser/owner can bypass triggers (T-026), single-region demo deployment limits (T-015 scope).
