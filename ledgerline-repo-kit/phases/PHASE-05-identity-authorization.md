# Phase 5: Identity, sessions and authorisation

**Target:** Sat 7 Nov. **Agents:** 05 backend, 07 security. **Skills:** clean-architecture-guard, threat-register.

## Objective
Every protected route knows who the actor is and what they may do, decided server-side, deny by default.

## Tasks
- [ ] P5.1 Migration: `users`, `sessions`, `account_permissions` (accounts table arrives in Phase 6; stub FK later via migration).
- [ ] P5.2 `domain/permissions`: pure policy `can(actor, action, accountGrant)`; table-driven unit tests mirroring `docs/AUTHZ_MATRIX.md` exactly.
- [ ] P5.3 argon2id hashing; login issues an opaque token, stores its hash; cookie `HttpOnly; Secure; SameSite=Lax`; logout revokes.
- [ ] P5.4 Auth plugin: resolves session to actor on every request; role comes from the database, never from the request.
- [ ] P5.5 Login rate limit and identical error for unknown user and wrong password.
- [ ] P5.6 Origin check on mutating routes.
- [ ] P5.7 Admin-only user and permission management; **no self-grant**; every grant/revoke written to an `audit_events` table (append-only, same privilege rules as ledger).
- [ ] P5.7b Expose `authorizeInTransaction(tx, actor, action, accountIds)` that reads grants `FOR SHARE`; revocation is an `UPDATE` on the grant row plus an `audit_events` insert (ADR-007). Authorisation refusals write a `transaction_attempts` row in a separate short transaction.
- [ ] P5.8 Tests: unauthenticated, wrong role, expired/revoked session, escalation via body fields (`role`, `user_id`), self-grant (AUTH-004), login enumeration (AUTH-005), cookie flags (AUTH-006).

### BalanceVault expansion additions (2026-11-09 — additive to the checkpoint order; every new capability gets explicit acceptance criteria)

- [ ] P5.9 **First-admin bootstrap script executable:** host command per `docs/AUTHZ_MATRIX.md` §C.1.3 (secret from env, refuse when an admin exists, `bootstrap_created` audit event, distinct `rotate-admin-credentials` path; never reachable via API).
- [ ] P5.10 **User onboarding and registration:** `POST /register` creates a user (role `ACCOUNT_HOLDER`) with **no accounts/grants/money authority**; argon2id + opaque hashed session tokens per `ADR-006`; login/logout flows as P5.3 already specify (REG-001/REG-002).
- [ ] P5.11 **Redis-backed API rate limiting:** per-actor (+ IP fallback pre-auth) limiter on register/login and money endpoints; refuse with `429` and no side effect; Redis **never** authoritative (`THREATS.md` T-060); disclosed fail-soft behaviour on Redis outage with the DB-level T-042 countermeasure unchanged (RATE-001/RATE-002).
- [ ] P5.12 **Production role verification prep (PRODROLE-001):** runtime-role privilege harness runs the ADR-005 boundary statements through **both** `pg` and Prisma clients; H-4 hosting-role record captured before P4.8.
- [ ] P5.13 Tests: registration authority boundary (no accounts reachable), duplicate-reject, bootstrap idempotency/refusal, limiter thresholds, degraded-limiter behaviour.

## Acceptance (Gate 5)
Every route has a permission test; no handler reads `role` or actor id from the request body; UI visibility is not relied upon anywhere.

## Closeout
Update T-006, T-007, T-014, T-025, T-031, T-032 only if their named tests pass. Add a `PROMPTS.md` entry (authorisation).
Suggested commits: `feat(auth): sessions and login`, `feat(authz): permission policy and enforcement`.
