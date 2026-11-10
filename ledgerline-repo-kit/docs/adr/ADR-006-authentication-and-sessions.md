# ADR-006: Authentication and sessions (D-11)

- **Status:** Proposed — awaiting Gate 3 human acceptance (bootstrap posture and rotation were approved in the 2026-11-07 decision set; `docs/AUTHZ_MATRIX.md` §C.1.3, T-050)
- **Date:** 2026-11-07
- **Owner:** human developer
- **Related phase:** Phase 3 (P3.6; `phases/PHASE-03-architecture.md`)

## Context

Money commands require an actor whose authority can be re-derived *inside* the transaction (the money path re-reads the session row `FOR SHARE` — SESS-001/T-048). Logout must therefore actually revoke, at a defined point in transaction order — which rules out purely stateless tokens. The demo runs over one origin (Next.js rewrites `/api/*` to the API) with cookies; challenge criteria also demand role confusion attacks be impossible from the client (P5.5: no trust in client-supplied role/account ids).

## Decision drivers

- Revocation semantics must be transactional and race-safe with money operations (T-046/T-048).
- Credential storage must never leak (no plaintext passwords, no raw tokens/keys in logs — AGENTS.md).
- Simplicity of explanation under interview.

## Options considered

1. **Stateless JWT with expiry.** No server-side table; but real revocation becomes impossible without a blocklist (re-introducing state plus complexity), and post-revocation "valid" tokens are precisely the floating-authority window T-048 forbids.
2. **Opaque session token stored hashed (chosen).** Logout/admin revoke simply mark the row; the money path's `FOR SHARE` re-read gives a transactional revocation point; one small table, fully explainable lifecycle.
3. **(Rejected sub-choice): storing the raw token.** A database leak would immediately give usable credentials; storing only the SHA-256 hash costs one lookup and removes replay value.

## Decision

1. **Login.** `argon2id` password hashing with per-user salt (parameters recorded in Phase 4 config); login rate-limited per account and per IP (T-041 flood family); unknown-user and wrong-password return the **identical** error (no account enumeration).
2. **Sessions.** On login, generate a cryptographically random opaque token (e.g. 256 bits); store **SHA-256(token)** in `sessions.token_hash` (unique), with `expires_at`, nullable `revoked_at`; the raw token is returned only once as an `HttpOnly; Secure; SameSite=Lax` cookie and is never stored or logged. Session records are append+lifecycle rows — revocation is a column update (authorised admin paths), not deletion. **Active-session predicate (one representation, Gate 3 final review):** a session is valid iff `revoked_at IS NULL AND expires_at > now()` — there is deliberately **no separate session `status` column** (`docs/schema-draft.sql`); every revocation path (logout, admin revoke, role-change/disable revoke, rotation) is the single statement `UPDATE sessions SET revoked_at = now()` taken `FOR UPDATE`.
3. **Transport and origin.** Next.js rewrites `/api/*` to the API so the browser sees one origin. Mutating routes require `Content-Type: application/json` and a same-origin `Origin` check. HTTPS in production (T-039 family). No tokens or secrets in logs; request logging excludes cookies/authorization headers.
4. **In-transaction re-read (the money-path rule).** The session row is re-read `FOR SHARE` inside every money transaction as the **first lock, before the `users` row** (ADR-003 order; SESS-001, T-048). An admin/logout revocation conflicting with that read has exactly two legal orders; a revoked session ⇒ `401 UNAUTHENTICATED`, never a business-mapping 404.
5. **Bootstrap and admin identity** — compared against the approved record at Gate 3 (`AUTHZ_MATRIX.md` §C.1.3 decision 12, `ACCEPTANCE.md` AC1.5, T-050): **bootstrap creation is disabled once an administrator exists** (a re-run refuses; there is *no* `--override` path in v1); credential rotation is the **separate, clearly distinguished host command** `rotate-admin-credentials`, never a bootstrap re-run, never reachable through the public API, emitting the distinct `admin_credential_rotation` audit event with the claimed operator **plus `operator_context`** (invocation host session and invocation source) — both honestly labelled a *claim*, not identity proof. Its safeguards: the operator id must come from the **host environment** (`LEDGERLINE_OPERATOR_ID`; a CLI-supplied value is refused), an exact typed confirmation phrase is required, the procedure is **refused in non-interactive/CI contexts by default**, and it **revokes all of the target admin's sessions in the same transaction**; the plaintext password never enters repo/chat/logs (only an argon2id hash is stored). The accepted residual **T-050 (ACCEPTED)** is the 2026-11-07 decision 10: operator identification in bootstrap/rotation is a host-sourced claim — attribution, not identity proof — accepted as the documented limitation.
6. **Role changes.** A role change (admin lifecycle) revokes the target's session rows in the same transaction (T-046 control) via the separate admin lock chain of ADR-003.

## Consequences

### Positive
- Revocation is real and transactional — the in-flight money command sees either the full authority window or none.
- Single cookie + hashed token: simple, honest story; session table doubles as the audit surface for active sessions.
- Enumeration-resistant login errors and rate limiting directly satisfy the adversarial criteria.

### Negative / trade-offs
- Session lookup is per-request database work (one indexed row read) — negligible at demo scale.
- `HttpOnly` means no browser-side validity checks; the client must rely on server responses (fine — server is the authority anyway).

### Risks and mitigations
- *Risk:* cookie set on non-HTTPS local dev without `Secure`. *Mitigation:* environment-driven cookie flags; `Secure` always on in production builds; local dev via localhost is exempted with a documented reason.
- *Risk:* token logged by accident in a URL query parameter design drift. *Mitigation:* tokens never travel in URLs — cookie only; security checklist asserts this.

## Verification

- SESS-001 (revocation races in-flight transfer — both legal orders asserted), T-046 (role-change same-transaction revocation), ROLE-001, login rate-limit tests, identical-error assertion for unknown user/wrong password, hardship cases: expired token, revoked token, missing cookie → 401 UNAUTHENTICATED; `assertGlobalInvariants` unaffected (auth touches no ledger).
- ARGON hashing verified by unit test (hash ≠ plaintext; verification cost measurement recorded).

## Revisit conditions

- A deployment target forbids sticky single-origin cookies → ADR amendment required (e.g. explicit token-header mode) — cookie policy is decision-bearing, not incidental.
- Multi-admin operational model arrives → revisit bootstrap/rotation only against the already-approved decision set; T-050 remains the recorded residual until changed.
