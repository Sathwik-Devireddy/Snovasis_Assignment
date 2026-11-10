# AUTHZ_MATRIX.md — Rev 4 (Gate 2 final decision set incorporated)

- **Phase:** 2 · **Rev:** 4 · **Date:** 2026-11-07 · **Status:** Draft for human review (Gate 2 — not yet approved by the human sign-off)
- **Human-approved decisions incorporated in Rev 4 (2026-11-07, do not reopen):** admin-only external deposits (H-2); no overdraft (row lock + balance-after-lock + CHECK); last-admin protection via the `admin_control` singleton; counter `accounts.event_last_seq` with per-entry value `account_event_seq` shared by postings and locked refusals; `account_status_detail` restricted to ADMIN/AUDITOR audit views; TIMING-001 best-effort and non-gating; close only at zero balance checked under the account lock; **one merged statement timeline** backed by event/attempt categories; bootstrap identity limitation accepted as a disclosed residual risk; lifecycle `ACTIVE`/`SUSPENDED`/`CLOSED` with SUSPENDED blocking both credits and debits; **bootstrap creation disabled once an administrator exists**, with any override/rotation as a clearly distinguished, audited, separate procedure.
- **Rev 4 changes:** §C.1.3 bootstrap/rotation separation (bootstrap is disabled once an ADMIN exists; rotation is a separate named procedure with distinct audit events); §F explicit SUSPENDED both-direction rule and zero-balance-close-under-lock; naming aligned to the approved `event_last_seq`/`account_event_seq` pair.
- Rev 3: admin-lifecycle lock order (sessions before `users`, ascending ids); §F account status lifecycle created; `--operator` demoted to a claimed-and-context-recorded value; target-visibility cross-ref.
- Rev 2: `admin_control` singleton serialization; bootstrap safeguards; session-row linearisation; global lock order.
- Rev 1: active-CUSTOMER restriction; bootstrap provisioning; last-admin guard; in-flight role-change linearisation.
- Baseline: `docs/PROPOSED_DEFAULTS.md` D-3, decisions H-2 (admin-only deposits) and the invariants confirmed in Phase 1.
- **Enforcement rule:** this table is the reference for the authorisation policy module *and* the API tests. Deny by default. Every check is server-side; grants, role and session validity are re-read **inside** the money transaction (`FOR SHARE`) so authorisation linearises with revocation.

## Legend

- ✅ = allowed (subject to the stated requirement)
- ❌ = never, regardless of grants
- Grant names (per account row `account_grants`): `VIEW`, `DEPOSIT`, `WITHDRAW`, `TRANSFER`. The role column states whether a grant of that kind may *exist* for the role and be exercised.
- Account kinds: only `CUSTOMER` accounts can ever be the target of a money operation.

## A. Account operations

| Operation | ADMIN | ACCOUNT_HOLDER | AUDITOR | Required account grant | Extra conditions |
|---|---|---|---|---|---|
| View account detail & current balance | ✅ any account | ✅ only granted accounts | ✅ any account | `VIEW` (admin/auditor: role-level) | Holder list is grant-filtered server-side |
| View statement (postings + attempts) | ✅ any account | ✅ | ✅ any account | `VIEW` (role-level for ADMIN/AUDITOR) | Content filtered per `REFUSAL_CODES.md` §6 |
| External DEPOSIT (money in from outside) | ✅ any **active CUSTOMER** account | ❌ (H-2) | ❌ | ADMIN: role-level; others no grant path | Destination must be an **active CUSTOMER** account (CLOSED/SUSPENDED refuses, T-012); journal balances vs `EXTERNAL_CLEARING` (T-013) |
| External WITHDRAW | ✅ any **active CUSTOMER** account | ✅ only granted accounts | ❌ | ADMIN: role-level; HOLDER: `WITHDRAW` | **Source must be an active CUSTOMER account**; funds check inside the transaction; no overdraft |
| TRANSFER (from source account) | ⚠ | ✅ | ❌ | ADMIN **and** HOLDER both need explicit `TRANSFER` on the **active CUSTOMER** source | ⚠ Admin has no special transfer privilege (anti-insider, T-025); funds check; no overdraft |
| TRANSFER (to destination account) | — | — | — | No grant needed on destination | Destination must be an **active CUSTOMER** account; SYSTEM destination refused (T-043, DEST-001); non-permitted/absent destination returns the uniform 404 envelope (AUTH-007) |
| Post ADJUSTMENT (balanced corrective journal) | ⚠ deferred | ❌ | ❌ | ADMIN: role-level `ADJUST` | **H-5:** deferred until after Gate 9; mandatory reason text; audited; can never edit history |

## B. Administration & platform operations

| Operation | ADMIN | ACCOUNT_HOLDER | AUDITOR | Extra conditions |
|---|---|---|---|---|
| Create user / assign role | ✅ | ❌ | ❌ | Cannot change **own** role ⚠; grants/role changes are audit events |
| Create account / manage its status | ✅ | ❌ | ❌ | Full status enum per §F: `ACTIVE` / `SUSPENDED` / `CLOSED`; every transition (suspend, resume, close) is admin-only and audited; non-`ACTIVE` accounts refuse all money movement; close is permitted only at **zero balance** (`NONZERO_BALANCE` otherwise, §F); `CLOSED` is terminal — reopen is not possible |
| Grant / revoke an account permission | ✅ | ❌ | ❌ | ⚠ Never to or from self (AUTH-004); every grant + revoke is an audit event; revocation linearisation per ADR-007 (T-041) |
| Grant DEPOSIT to a holder | ❌ | — | — | **H-2 policy**: no holder ever receives DEPOSIT in v1 |
| Change a user's role | ✅ | ❌ | ❌ | ⚠ Last-admin guard (§C); user's sessions revoked (§D); audited |
| Disable a user | ✅ | ❌ | ❌ | ⚠ Last-admin guard (§C); user's sessions revoked (§D); audited |
| Revoke sessions of a user | ✅ any user | ✅ own sessions only | ✅ own sessions only | Audited; in-flight semantics per §D |
| View audit events (logins, attempts, grants, role changes) | ✅ | ❌ (own session events only*) | ✅ | *Proposed default, review at Gate 2 |
| Run reconciliation / view reconciliation result | ✅ | ❌ | ✅ | INV-001 evidence surface |
| Manage idempotency records | ❌ (no edit/delete path) | ❌ | Read-only view ✅ | No expiry in v1; deletion is owner-role SQL only, disclosed (T-038) |
| Ledger row edit / delete via API | ❌ | ❌ | ❌ | No endpoint exists; DB role lacks privilege (LED-001/002) |

## C. Administrator lifecycle

### C.1 Bootstrap provisioning of the first administrator (secure by construction)

1. The first ADMIN is created by an **out-of-band bootstrap step** at deployment time (e.g. `npm run bootstrap` on the host, or a migration-seed + one-shot script). It is never executed through the public API, and no self-registration path exists anywhere.
   - **Amendment (BalanceVault expansion, human instruction 2026-11-09):** a self-service registration route now **does** exist, for **holder onboarding only** (`POST /register`; `docs/ACCEPTANCE.md` AC1.5 amendment, REG-001/REG-002). What this rule protected for administrators is unchanged: registration can never create an ADMIN or AUDITOR, provide an account, or grant permission (deny-by-default); first-admin provisioning remains the out-of-band bootstrap path in §C.1.3, disabled once an administrator exists. The original sentence "no self-registration path exists anywhere" no longer applies to holder-only registration.
2. The bootstrap password is **randomly generated by the host environment** (e.g. from an env var the operator sets, or an output printed once), stored only as an argon2id hash in the DB. The plaintext password never enters the repository, chat, logs or tickets (T-015, T-034).
3. Because v1 has no self-service password change (declared non-goal), the bootstrap rule is constrained instead: bootstrap runs **once per environment** and is **disabled once an administrator exists** (approved decision, 2026-11-07) — once an ADMIN row exists, the bootstrap entry point refuses with no override path through bootstrap itself. **Any separate override/rotation procedure must be clearly distinguished from bootstrap (approved decision); Rev 4 defines it:**
   - credential rotation / recovery is a **separate host command** (e.g. `rotate-admin-credentials`), never a bootstrap re-run, and is **never reachable through the public API**;
   - it emits a **distinct audit event type** (`admin_credential_rotation`, clearly different from the bootstrap `bootstrap_created` event), containing operator claim, target user, timestamp and outcome;
   - its safeguards (Rev 3 revised, retained): the operator id must come from the **host environment** (`LEDGERLINE_OPERATOR_ID` injected by the deployment tooling / shell of the trusted operator session); a value supplied only as a CLI argument, or a bare `--operator` without that env var set from a trusted deployment context, is refused. The audit event stores the env-derived id **plus `operator_context`** (invocation host session and invocation source as observed by the runtime) — both honestly labelled a **claim**, not identity proof: true operator identity verification (SSO/mTLS/person) is out of scope for v1 and is **accepted as a documented residual risk** (approved decision; `THREATS.md` T-050). The runtime environment is the documented deployment context only (the same host that holds the DB credentials); running it on any other machine is refused unless an explicit runbook flag re-hosts it. An exact typed confirmation phrase is also required.
   - the rotation procedure is **refused in non-interactive contexts** (CI/CI-like shells) unless `BOOTSTRAP_ALLOW_ROTATION_CI=true` is explicitly exported by the host — the default is to refuse;
   - every rotation run **revokes all of the target admin's sessions in the same transaction** (stolen/rotated credentials cannot ride an old session);
   - as with bootstrap, the plaintext password/secret never enters the repository, chat, logs or tickets (T-015, T-034); only an argon2id hash reaches the database.
4. Every bootstrap creation is itself an audit event (actor: `system:bootstrap`).
5. Demo seeding (holders, accounts) is separate, synthetic-only and idempotent (SEED-001, T-044). Demo credentials are documented **as demo** credentials and are never administrator-grade.

### C.2 Last-active-administrator guard (Rev 2: serialized)

**Race that Rev 1 did not close:** counting admin rows and refusing demotion inside one transaction on the `users` locks does **not** stop two concurrent demotions of two *different* administrators — each concurrent count sees the other as still active and both proceed → zero admins remain. Rev 2 fixes this with a dedicated serialization point:

- **`admin_control` singleton row** (one fixed row in a small `platform_control` table). Every operation that can *reduce* the active-admin count — role change away from ADMIN, admin-account disable, and the edge case of an admin being merged/removed — must take `SELECT … FOR UPDATE` on the **`admin_control` row first** (beginning of its transaction), *then* count active admins, *then* perform the change. Two such operations therefore serialise: the second waits, re-counts on the first's commit, and sees the true remaining count.
- The count check and the demotion still share the same transaction, and the `users` row of the target is updated under the same `users` `FOR UPDATE` used for linearisation (§D).
- Grant revocation must be included when it can strand admin authority? No — grants are account-scoped, not role-scoped; the guard covers role changes and disables only, exactly the paths that can reach zero administrators.
- Refusal on reaching zero: `LAST_ADMIN_PROTECTED` (409, `REFUSAL_CODES.md` §3).
- **Lock order (Rev 3, explicit):** every count-reducing admin-lifecycle transaction acquires locks in exactly this order: **`admin_control` row (`FOR UPDATE`) → the target user's session rows (`FOR UPDATE`, *ascending id*, all of them) → the target's `users` row (`FOR UPDATE`)** (sessions deliberately *before* the users row, matching the money path's `sessions → users` segment). Admin-lifecycle transactions never acquire money-path locks (`grants`/`idempotency`/`accounts`), so no cycle can form with commands holding those locks.
- **Runtime privilege for the serialisation point (decided at the Gate 3 final review, ADR-005):** `ledgerline_app` receives `GRANT SELECT, UPDATE (updated_at) ON admin_control` — PostgreSQL requires the UPDATE privilege on at least one column of every table named in a locking clause before `FOR UPDATE`/`FOR SHARE` is permitted (PostgreSQL SELECT reference, verified 2026-11-08). `updated_at` is the only column the lifecycle touches under the lock, so this is simultaneously the minimal sufficient grant and a harmless audit-touch capability. `FOR SHARE` on `admin_control` would **not** serialise two concurrent demotions (share locks do not conflict with one another), so the lock kind stays `FOR UPDATE`; the singleton `CHECK (id = 1)` stays immutable to writers.
- Tests: **ADMIN-001** (sequential guard + bootstrap rules, unit/API), **ADMIN-002** (concurrency: two independent connections demote two different administrators simultaneously — at least one demotion is blocked and **at least one active administrator always remains**). Threats: **T-047**, plus original T-045.

## D. Role change & session revocation during an in-flight financial transaction

D-13/ADR-007 covered grant revocation; here is the full rule, extended by Gate 2 review:

1. **Role is never asserted from token/cookie claims.** Every request's actor role and grants are re-read from the database; revoking a role immediately tightens what new requests can do.
2. **Role change / user disable acquires its locks in the admin-lifecycle order (Rev 3):** `admin_control` first when the operation can reduce the active-admin count, then **the target user's session rows (`FOR UPDATE`, ascending id) and only then the target `users` row (`FOR UPDATE`)**; the money command reads its actor's session row and `users` row `FOR SHARE` in the same relative order (`sessions → users`, cf. §D.6). `FOR UPDATE` and `FOR SHARE` on the same rows conflict — so a role change (or user disable) arriving mid-command *waits* until the command commits, or the command detects the change when it reaches its authorisation read.
3. Consequence (two legal orders, nothing else exists):
   - The operation read its authorisation before the change committed → **it completes** (linearised *before* the change) — allowed, documented, not a leak;
   - any operation starting after the change commits sees the new role / disabled user → refused.
   This is the same rule as grant revocation (ADR-007, T-041, AUTH-008) — one consistent linearisation story to defend.
3a. **Session-row locking (Rev 2 clarification) — requests racing logout/session revocation:**
   - A money command does **not** trust the HTTP-layer session check as authority: it re-reads its actor's **session row `FOR SHARE` inside the money transaction** (immediately: sessions → users is its first lock pair, cf. §D.6). A session whose **active-session predicate fails** — `revoked_at IS NOT NULL`, `expires_at <= now()`, or bound to a different actor — fails the transaction authorisation.
   - **Single session-state representation (Gate 3 final review):** a session is *active* iff `revoked_at IS NULL AND expires_at > now()`; `sessions` has deliberately **no `status` column** (`docs/schema-draft.sql`), and no normative wording may introduce a second state representation. The active-session predicate is the only validity rule; expiry and revocation are one predicate, evaluated inside the money transaction.
   - **Logout / admin revoke / role-change-triggered revoke** performs `UPDATE sessions SET revoked_at = now()` taking that row `FOR UPDATE`; this conflicts with the command's `FOR SHARE` on the same row, so the revocation and the command **serialise on the session row**: the command either validated before the revocation committed (completes — linearised before) or sees the revoked row (`revoked_at` set) and is refused `UNAUTHENTICATED`. Exactly two legal orders; no third.
   - A request whose *HTTP-layer* (non-transactional) authentication read observed the session pre-revocation can never move money in that window — the authoritative check is the in-transaction one. Read-only requests may still complete with a session that was concurrently revoked; that is a read racing a logout and is accepted (no money effect).
   - Replay correctness is preserved for free: replay re-validates the session row too, so a stolen-key replay after logout is refused (IDEM-006).
   - Test: **SESS-001** (concurrency): logout / revoke races an in-flight transfer via independent connections with a forced-overlap hook → exactly one legal order holds, money either completes (authorised-before) or is refused, and post-revocation requests are 401. Threat: **T-048**.
4. **Session revocation is authority removal for *new* requests only.** Sessions revoked (logout, logout-all, admin revoke, role-change-triggered revoke) do not roll back an operation that already passed its authorisation point (order 3 above); they merely guarantee that *subsequent* requests must re-authenticate. No retry/refresh of a revocation racing a commit can double-apply an effect — idempotency keys remain scoped and replay still re-checks authorisation (IDEM-006).
5. **Role-change follow-up (mandatory):** changing a user's role or disabling them **revokes all of that user's sessions** in the same transaction. Recovering a stolen/compromised account therefore cannot leak through an old session.
6. Deadlock safety: the **global lock orders** (Rev 3, two cycle-free sequences):
   - **Money path** (money command): `actor's session row (FOR SHARE) → actor's users row (FOR SHARE) → grant rows (FOR SHARE, ascending id) → idempotency key claim (a unique INSERT — not an explicit lock step; the uniqueness conflict makes a concurrent duplicate wait until the winner commits/rolls back, ADR-003) → customer account rows (FOR UPDATE, ascending id)`.
   - **Admin-lifecycle path** (role change / disable / demotion): `admin_control row (FOR UPDATE, when count-reducing) → target's session rows (FOR UPDATE, ascending id) → target's users row (FOR UPDATE)` — and nothing beyond that.
   Both paths agree on the shared `sessions → users` segment (ascending ids within any group), every transaction locks strictly left-to-right within its path, and the paths never share a lock after their common segment in *opposite* order — so no cycle can form (CON-002). Tests: **ROLE-001** and **SESS-001** (forced overlaps, hook-based), threats **T-046**, **T-048**.

## E. Gate 2 feedback → change map (review aid)

### Rev 1 (2026-11-06)

| Feedback item | Resolved in |
|---|---|
| 1. Admin external withdrawals restricted to active CUSTOMER accounts | §A DEPOSIT/WITHDRAW/TRANSFER rows (+ destination rules) |
| 2. Secure initial administrator provisioning | §C.1 (out-of-band bootstrap, host-generated password, single-run rule, audit event) |
| 3. Last active administrator cannot be removed/demoted | §C.2 + `LAST_ADMIN_PROTECTED` code + ADMIN-001 + T-045 |
| 4. Role-change & session-revocation behaviour in-flight | §D (FOR UPDATE/FOR SHARE linearisation, two legal orders, session-revoke semantics) + ROLE-001 + T-046 |

### Rev 2 (2026-11-07)

| Feedback item | Resolved in |
|---|---|
| 1. ADMIN-002 last-admin concurrency | §C.2: `admin_control` singleton row `FOR UPDATE` serialises all count-reducing admin operations; concurrency test ADMIN-002; threat T-047 |
| Clarification: bootstrap `--override` safeguards | §C.1.3: `--operator <id>` mandatory + exact typed `--confirm` phrase + CI-context refusal by default + distinct `bootstrap_override` audit event + same-transaction session revocation |

### Rev 3 (2026-11-07)

(Finding numbers follow the Rev 3 review's nine findings.)

| Feedback item | Resolved in |
|---|---|
| 1. Lock-order consistency | §C.2 + §D item 2 + §D.6: admin-lifecycle locks sessions **before** the `users` row (ascending ids, all sessions); `admin_control` remains the first lock for count-reducing operations; two cycle-free paths stated (money path vs admin-lifecycle path) instead of one misleading chain; T-046 control text updated |
| 3 (cross-ref). SYSTEM destination disclosure + 8. uniform timing | External behaviour defined in `REFUSAL_CODES.md` §3 (target-visibility rule + TIMING-001); §A rows point to it; destination rule for transfers unchanged (no grant on destination) |
| 5. Account status enum | **New §F**: `ACTIVE`/`SUSPENDED`/`CLOSED`, transitions (admin-only, audited, zero-balance close precondition with `NONZERO_BALANCE`), money-operation rules under lock |
| 7. Bootstrap operator identity | §C.1.3: `--operator` is a claimed label sourced from the trusted host environment (`LEDGERLINE_OPERATOR_ID`), invocation context recorded alongside; CLI-only identity refused; person-identity verification disclosed as a v1 limitation |
| Clarification: session-row locking & revocation linearisation | §D.3a: session row re-read `FOR SHARE` *inside* the money transaction; revocation takes `FOR UPDATE`; sessions `→ users` order consistent with §D.6; SESS-001 + T-048 |

### Rev 4 (2026-11-07 — Gate 2 final decision set incorporated)

(The numbered decisions are the human's approved list of 2026-11-07; they fix earlier open points and are not reopened.)

| Approved decision | Where it lives |
|---|---|
| 1. Admin-only external deposits | §A/§B (unchanged, H-2) |
| 2. No overdraft (row lock, balance after lock, CHECK) | §A source rules; `PROPOSED_DEFAULTS.md` D-5/D-6/D-7; AC5.x |
| 3. Last-admin protection via `admin_control` singleton | §C.2 (unchanged) |
| 4. Account counter column = `accounts.event_last_seq` | §F note + `PROPOSED_DEFAULTS.md` D-6 + `REFUSAL_CODES.md` §5 (Rev 4 naming; `last_seq` superseded) |
| 5. Per-entry value = `account_event_seq`, shared by postings and locked refusals | `REFUSAL_CODES.md` §5; `DATA_MODEL.md`; test plans |
| 6. `account_status_detail` ADMIN/AUDITOR audit views only | §F + `REFUSAL_CODES.md` §4/§6; test ASD-001 |
| 7. TIMING-001 best-effort, non-blocking, not a required CI gate | `ACCEPTANCE.md`/`TEST_PLAN.md`/`THREATS.md` T-020 |
| 8. Close only at zero balance, checked under the account lock | §F transitions |
| 9. Statements: one merged timeline, events/attempts categories | `REFUSAL_CODES.md` §5 merge rule; AC8.2; STMT-002; T-033 |
| 10. Bootstrap identity limitation accepted as residual risk | §C.1.3 + `THREATS.md` T-050 (ACCEPTED) |
| 11. Lifecycle `ACTIVE`/`SUSPENDED`/`CLOSED`; SUSPENDED blocks credits and debits; ADMIN/AUDITOR may view | §F (made explicit) |
| 12. Bootstrap disabled once an admin exists; separate audited rotation procedure | §C.1.3 (rewritten: no `--override` on bootstrap; `rotate-admin-credentials` with `admin_credential_rotation` audit event) |

### Gate 3 final review (2026-11-08 — consistency corrections, no decision set reopened)

| Correction | Where | Reason |
|---|---|---|
| Session revocation standardised on `revoked_at` (one state representation; no session `status` column; active-session predicate defined) | §D.3a + `docs/schema-draft.sql` sessions comment + ADR-006 item 2 + AC1.4 | the earlier §D.3a wording wrote `UPDATE sessions SET status = 'REVOKED'` although the schema has no such column — two state representations, one of them unimplemented |
| The runtime privilege that permits the `admin_control FOR UPDATE` serialisation point is decided: `GRANT SELECT, UPDATE (updated_at)` | §C.2 + ADR-005 item 2 + `docs/schema-draft.sql` grants block | PostgreSQL requires UPDATE on ≥1 column of every locking-clause table (SELECT reference, verified); previously SELECT-only was assumed sufficient and left deferred |
| The same locking-clause rule documented for the money path's `FOR SHARE` reads | §D.6 + ADR-005 + `docs/schema-draft.sql` grants comment | the lifecycle tables' UPDATE grants are *necessary* for `FOR SHARE`, not incidental |

**2026-11-08 follow-up (human alone):** the human formally accepted these four technical decisions (provenance: `docs/DISCOVERY.md` §5b) — **without** closing Gate 3. All seven ADRs remain `Status: Proposed`; migration work stays blocked until the human accepts the ADRs individually; Phase 4 has not been started (`phases/PHASE-04-foundation-deploy.md` untouched).

## F. Account status lifecycle (Rev 3 — resolves the undefined status enum)

**Status enum (all valid statuses; nothing else exists):**

| Status | Money operations | Views/reads | Meaning |
|---|---|---|---|
| `ACTIVE` | Allowed per normal grants (source and destination) | Normal | The only status that can send or receive money |
| `SUSPENDED` | Refused as source **and** destination — SUSPENDED blocks **both credits and debits** (approved decision): deposit to, transfer-credit to, withdrawal from and transfer-debit from are all refused with `ACCOUNT_NOT_ACTIVE`; the external envelope follows the target-visibility rule | Normal per grant — **ADMIN/AUDITOR may still view** suspended accounts, and holders with `VIEW` see them read-only | Temporary hold; resume is allowed; used to stop movement during an investigation |
| `CLOSED` | Refused as source and destination, permanently | Normal per grant | Terminal; the account can never transact again; reopen is not implemented |

System-kind accounts are not created, closed or suspended by this lifecycle; they are schema constants.

**Transitions (all by ADMIN only, all audited):**

| From → To | Allowed? | Additional rules |
|---|---|---|
| `ACTIVE → SUSPENDED` | ✅ | Audited; in-flight money commands are unaffected (linearisation per §D). |
| `SUSPENDED → ACTIVE` (resume) | ✅ | Audited. |
| `ACTIVE → CLOSED` | ⚠ **only at zero balance** | Audited; refused with `NONZERO_BALANCE` otherwise. The zero-balance check runs **under the account's row lock** (same lock discipline as money commands — approved decision), so a concurrent posting cannot slip between check and close. Closing drains nothing — permitted money operations (or, after Gate 9, a documented corrective posting) must bring the balance to zero first. |
| `SUSPENDED → CLOSED` | ⚠ **only at zero balance** | As above (zero-balance check under the account lock). |
| `CLOSED → anything` | ❌ | Terminal — no transition out, ever. Reopen requests are refused (internal detail of `ACCOUNT_NOT_ACTIVE`; a new account must be created instead). |

**Money-operation rules:** every money command requires source status = `ACTIVE` and destination status = `ACTIVE`, checked under the respective account locks (D-8 step 5). `ACCOUNT_NOT_ACTIVE` rows internally record `account_status_detail` (`SUSPENDED`/`CLOSED`); the external envelope follows `REFUSAL_CODES.md` §3's target-visibility rule (granular 409 only for account-visible callers). Views are never blocked by status.

## Design consequences to implement (unchanged from Rev 0 where applicable)

1. **ADMIN** cannot transfer customer money out of an account they hold no `TRANSFER` grant on — deposit/withdraw is the admin "cash desk"; transfers are still grant-bound (T-025).
2. **ACCOUNT_HOLDER** moves money only *out of* accounts carrying the specific grant, and only into active CUSTOMER accounts.
3. **AUDITOR** has zero write paths in the API surface.
4. Grant revocation races resolve per ADR-007 (AUTH-008); role changes per §D (ROLE-001); session revocation per §D.3a (SESS-001); last-admin demotions serialise on `admin_control` (ADMIN-002).
5. Every permission/role/session-admin change is an audit event with actor, subject, action, and reason.

## Gate 2 checklist for this file

- [ ] Human owner performs the final Gate 2 sign-off on this **Rev 4** matrix (required before Phase 5 implements it).
- [ ] Deposit policy recorded as H-2 = admin-only (approved 2026-11-07 decision set).
- [ ] §C.1.3 bootstrap-disabled-once-admin-exists + separate audited rotation procedure approved as written (or edited) — decision 12.
- [ ] §D + §D.3a in-flight linearisation and the two lock paths (§D.6) approved.
- [ ] §F account status enum, SUSPENDED both-direction rule, zero-balance close under lock and `NONZERO_BALANCE` close rule approved.
- [ ] The approved naming pair (`accounts.event_last_seq` counter / `account_event_seq` per-entry value, decision 4+5) is reflected in every schema/test reference.
- [ ] A8 statement visibility (REFUSAL_CODES §6) confirmed.
- [ ] Any future change here changes the policy module + tests in the same commit.
