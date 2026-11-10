# REFUSAL_CODES.md — Rev 4 (Gate 2 final decision set incorporated)

- **Phase:** 2 · **Rev:** 4 · **Date:** 2026-11-07 · **Status:** Draft, awaiting final human Gate 2 sign-off
- **Approved naming (2026-11-07 decisions 4+5):** the account counter column is **`accounts.event_last_seq`**; the per-entry sequence value stored on postings *and* locked refusals is **`account_event_seq`** (one shared column name in `ledger_entries` and `transaction_attempts`). Older names (`last_seq`, `account_seq` for this counter, `event_seq`) are superseded.
- **Approved statement shape (decision 9):** **one merged timeline** backed by the two categories (`events` semantics / `attempts` semantics) — exact merge rule in §5.
- **Approved visibility (decision 6):** `account_status_detail` is ADMIN/AUDITOR audit-view content only — never exposed to holders or in any external response.
- **Approved timing (decision 7):** TIMING-001 is best-effort and non-blocking — it is **not** a required CI pass criterion.
- Rev 3 changes: lock-order/wording cleanup; shared per-account event counter for postings *and* locked business refusals; business-refusal wording no longer implies every refusal has a measured balance; destination classification no longer disclosed to unauthorised callers; account status enum defined; `--operator` demoted from identity proof; timing promise made realistic (mitigations + statistical test TIMING-001); raw JSON integer tokens converted to `BigInt`, never via IEEE-754 (T-049). See §7 for the item-by-item map.

## 0. Design rule: two-sided truth

| Face | Audience | Rule |
|---|---|---|
| **External envelope** (HTTP responses, caller-visible codes) | Any caller, including attackers | Never distinguishes "exists but forbidden" from "does not exist", and never reveals more than the caller is entitled to — including **account classification** (SYSTEM kind, status, `account_status_detail`) for accounts the caller cannot view. Shape, message and HTTP status are identical across the split cases. **Latency:** identical status/body are hard requirements; latency differences are *mitigated* (single code path, no case-dependent DB round-trip shortcut) and checked by the **statistical test TIMING-001** (e.g. median-difference within a documented tolerance over a fixed sample size). No absolute "identical latency" promise is made — that would be dishonest. TIMING-001 is **best-effort and non-blocking**: it records evidence but is not a required CI pass criterion. |
| **Internal audit record** (`transaction_attempts` / audit events) | Admin/auditor audit views (and, where A8 allows, the target holder's statement) | Records the **exact** truth: precise reason code (+ status subtype detail where applicable), actor, id-as-supplied, measurable balance where one was honestly obtained. |

Payloads are **never** stored or echoed on either face (AMT/LOG policy; T-015, T-042).

## 1. Refusal classes

| Class | What it is | Where it gets recorded | HTTP |
|---|---|---|---|
| **Transport / validation refusal** | Malformed or inauthentic input: bad JSON, missing fields, wrong types or malformed integer tokens, oversized body, no/invalid credentials | **No** attempt row (no accountable target exists yet); validated at the HTTP edge | 400 / 401 / 429 |
| **Business refusal** | Verified actor, authorised command, and the **ledger rules or account state** refuse it | Committed **inside** the money transaction: attempt row (REFUSED) + idempotency row stores the refusal as the replayable outcome (D-8 steps 3 and 5 — the pre-lock and under-lock refusal phases). *A balance is stored only where the refusal's check ran after the balance was actually read under the account lock — pre-lock business refusals carry NULL (§4 is authoritative; §2's canonical order defines which codes are pre-lock).* | 409 |
| **Authorisation refusal** | Actor lacks the grant, or account is absent from the security view | Money tx **rolls back** (no key consumed); separate short audit tx writes one compact attempt row — internally `FORBIDDEN` or `ACCOUNT_NOT_FOUND` per the truth, externally one uniform envelope (§3) | 404 (uniform) |
| **Infrastructure failure** | DB error, lock timeout, crash — **no authoritative outcome was reached** | Everything rolls back; key **not** consumed; best-effort, rate-limited **FAILED** attempt row written in a separate short transaction (D-9). Not shown on statements (§5) | 500 / 503 |

## 2. Malformed input vs business refusal — the boundary, with integer precision

**Rule: shape is transport, value is business.** If the input is not even the right *shape*, the command does not exist semantically → transport. If the input has the right shape but the *ledger rules* reject the value → business refusal, recorded.

**Integer precision (T-049, findings item 9):** `amount_minor` is validated against the **raw JSON bytes**, never against an IEEE-754 number produced by a naive `JSON.parse`:

1. The handler extracts the raw token for each money field; it must match the pure integer literal grammar `-?(0|[1-9][0-9]*)` (no decimals, no exponent, no leading `+`, no surrounding whitespace variants). Anything else → `VALIDATION_FAILED` (400).
2. The token is converted to a **`BigInt` directly** (`BigInt(tokenString)`) — the money path never converts an amount through `Number`, so no rounding can silently map an out-of-range token onto a valid amount. A max-safe-integer-unsafe token cannot masquerade as a smaller valid value because its exact decimal digits are what flow into the comparison.
3. Tokens whose magnitude exceeds the **signed 64-bit BIGINT range** (`> 2^63−1` or `< −2^63`) are malformed *for the domain type* → `VALIDATION_FAILED` (400) — they can never be stored.
4. Every integer in **responses** (amounts, balances, event sequences) is serialised as a **JSON string** (documented convention; any client parser keeps full precision). API docs must state this.

| Input on a money operation | Class | Code | HTTP | Attempt row |
|---|---|---|---|---|
| Body not valid JSON; required field missing; account/destination id not a UUID; currency not a string; oversized body | Transport | `VALIDATION_FAILED` | 400 | No |
| `amount_minor` raw token not matching the integer grammar (string, `100.5`, `1e3`, `+7`, whitespace, `null`) | Transport | `VALIDATION_FAILED` | 400 | No |
| `amount_minor` token magnitude beyond the signed 64-bit range | Transport | `VALIDATION_FAILED` | 400 | No |
| `amount_minor` a valid raw integer token but ≤ 0 or above the per-operation cap | Business | `INVALID_AMOUNT` | 409 | Yes — but always with `balance_at_attempt_minor = NULL` (refused pre-lock; §4) |
| Unknown currency code (e.g. `USD` in the INR-only system) | Business | `CURRENCY_MISMATCH` | 409 | Yes (balance NULL) |
| Missing/empty `Idempotency-Key` on a money operation | Transport | `VALIDATION_FAILED` | 400 | No |
| Well-formed everything, but insufficient funds / inactive source / same account / disallowed destination kind | Business | per §3 | 409 (source checks) / **uniform 404 envelope** where the finding concerns an account the caller cannot view (§3 target-visibility rule) | Yes — balance recorded **only** if that code's check actually happens after the balance was read under the lock (§4 matrix) |

Canonical validation order (defines where each refusal happens, and therefore what it may honestly claim):
1. transport validation (§2 shape rules incl. raw token grammar) → 2. pre-lock semantic checks (`SAME_ACCOUNT`, `INVALID_AMOUNT`, `CURRENCY_MISMATCH`, destination-kind checks — decided from the request and account metadata as visible to the caller, **before any lock or balance read**) → 3. acquire account row locks → 4. under-lock checks (status `ACTIVE`, funds) → 5. post.

(The money transaction's authentication/authorisation reads and its idempotency claim — `PROPOSED_DEFAULTS.md` D-8 steps 1, 1b and 2 — sit between transport validation and the pre-lock checks; they take no account row lock and read no balance, so this canonical phase order and D-8's numbered step order agree.)

Rationale: shape errors are client bugs with no financial interpretation; recording them as business refusals would pollute the ledger evidence with junk rows and invent "balances" that were never read.

## 3. Reason codes — closed list v3

Two columns per code: what the **caller** sees and what the **attempt row** says. Codes here are the only values any layer may return/store; adding one requires a test + a doc update in the same commit.

**Target-visibility rule (closes the SYSTEM-account disclosure conflict):** an error about an account the caller **cannot view** (no role-level VIEW for ADMIN/AUDITOR, no account `VIEW` grant for a holder — the normal case for a transfer *destination*) returns the **uniform 404 `ACCOUNT_NOT_FOUND` envelope**, regardless of whether the account is absent, forbidden, closed, suspended, or of kind SYSTEM. The exact cause is stored internally. Granular 409 codes about a target account are issued **only** to account-visible callers (e.g. an ADMIN performing a deposit to a SYSTEM account gets the true 409 `SYSTEM_ACCOUNT_NOT_ALLOWED` — admins must know why their own cash-desk operations are refused).

| Internal code | Class | External HTTP + code | Attempt row? | Notes |
|---|---|---|---|---|
| `VALIDATION_FAILED` | Transport | 400 `VALIDATION_FAILED` | No | Malformed input only (§2, incl. raw-token grammar and 64-bit range) |
| `UNAUTHENTICATED` | Transport | 401 `UNAUTHENTICATED` | No | Missing/expired/revoked session |
| `RATE_LIMITED` | Transport | 429 `RATE_LIMITED` | No | Login flood or forbidden-call flood (T-042 caps audit writes too) |
| `FORBIDDEN` | Authorisation | **404 `ACCOUNT_NOT_FOUND`** — identical envelope to the next row | Yes (internal `FORBIDDEN`) | Grant missing on a real account. Externally indistinguishable from non-existence |
| `ACCOUNT_NOT_FOUND` | Authorisation | **404 `ACCOUNT_NOT_FOUND`** — identical envelope | **Yes** — persisted without any account reference (AUTH-009, §5) | Id resolves to no account. Identical status and body; latency differences only *mitigated* and checked statistically (TIMING-001, §0) — no absolute identical-latency claim (T-020) |
| `INSUFFICIENT_FUNDS` | Business | 409 `INSUFFICIENT_FUNDS` | Yes (§4: balance recorded) | Withdrawal/transfer exceeds the balance read under the lock (source — caller always holds the grant, so entitled to the detail) |
| `ACCOUNT_NOT_ACTIVE` | Business | Source: 409 `ACCOUNT_NOT_ACTIVE`. **Destination: uniform 404 envelope** unless the caller is account-visible (§3 rule) | Yes (§4: balance recorded for locked rows; internal detail stores `SUSPENDED` vs `CLOSED`) | Account status not `ACTIVE` (T-012/T-040); statuses per `AUTHZ_MATRIX.md` §F |
| `SAME_ACCOUNT` | Business | 409 `SAME_ACCOUNT` | Yes (§4: balance **NULL**) | Transfer source = destination; detected pre-lock |
| `INVALID_AMOUNT` | Business | 409 `INVALID_AMOUNT` | Yes (§4: balance **NULL**) | Valid raw token ≤ 0 or above cap; detected pre-lock — no balance ever read |
| `CURRENCY_MISMATCH` | Business | 409 `CURRENCY_MISMATCH` | Yes (§4: balance **NULL**) | Pre-lock; in v1 only INR exists |
| `SYSTEM_ACCOUNT_NOT_ALLOWED` | Business | **Uniform 404 envelope** for non-account-visible callers; granular 409 only for account-visible callers (§3 rule) | Yes (§4: balance **NULL**; internal audit distinguishes this from `ACCOUNT_NOT_FOUND`) | Destination is a SYSTEM (clearing/adjustment) account (T-043, DEST-001): externally it cannot be distinguished from an absent destination — no existence or classification leak |
| `KEY_REUSED` | Idempotency | 409 `KEY_REUSED` | **No** — original attempt row already exists; a second row would fabricate history | Same scoped key, different canonical payload (IDEM-002) |
| `LOCK_TIMEOUT` | Infrastructure | 503 `LOCK_TIMEOUT` | Yes — one **FAILED** row (best-effort; §5) | lock/statement timeout; **retryable with the same key**; key not consumed |
| `INFRA_FAILURE` | Infrastructure | 500 `INFRA_FAILURE` | Yes — one **FAILED** row (best-effort; §5) | Unexpected DB/runtime failure |

**FAILED rows:** recorded on a **best-effort** basis by an independent, contention-free mechanism (§5): a short transaction that touches only the attempt table, takes no account locks and no money-order locks, writes `global_seq` from a dedicated SEQUENCE, and is rate-limited per actor (T-042). If the insert itself fails (db down, timeout), the failure is logged and the response stands — retries are the remedy, never a second mechanism that could double-move money. FAILED rows are never statement-visible; the idempotency key is not consumed; the prescribed client behavior is retry with the same key.

**Administrator lifecycle (from `AUTHZ_MATRIX.md` §C/§F):**

| Internal code | External HTTP + code | Recorded via | Notes |
|---|---|---|---|
| `LAST_ADMIN_PROTECTED` | 409 `LAST_ADMIN_PROTECTED` | Audit event (not an attempt row) | Role-change/disable that would leave **zero active administrators** is refused after serialisation on the `admin_control` row (ADMIN-001/ADMIN-002, T-045/T-047) |
| `NONZERO_BALANCE` | 409 `NONZERO_BALANCE` | Audit event (not an attempt row) | Closing an account with a non-zero balance is refused; drain via permitted money ops first (or a documented corrective posting after Gate 9). The balance value is **audit-event content only** for admins, never a `transaction_attempts` row |

**Replay re-evaluation gate (same key + same payload → a stored outcome; D-8 step 2, `IDEMPOTENCY_BEHAVIORS.md` row 7, IDEM-006):** before *any* stored result — success or committed refusal — is returned to a replaying caller, the replaying transaction re-evaluates, in its declared lock order, as an **evaluation-only** pass (no writes, no counter bump, no new attempt row). The replay promise itself is **semantic** (ADR-004 §1a): the stored status and stored business values are returned (money/sequences as JSON strings, T-049) plus `replayed: true`; byte-identical JSON is deliberately not promised (JSONB normalisation):

1. **Session validity** — the session row was already re-read `FOR SHARE` before the idempotency claim (D-8 step 1). A concurrently revoked or expired session therefore fails **there**, with **401 `UNAUTHENTICATED`** — a revoked session can never reach a stored response, and its revocation is an authentication failure (never a 404/409).
2. **Grant / visibility** — the target-account grant rows were read `FOR SHARE` fresh at D-8 step 1b, linearised with revocation (ADR-007): a grant revoked or visibility lost since the original attempt already refused at step 1b with the **single uniform 404 `ACCOUNT_NOT_FOUND` envelope** (§3 target-visibility rule) — never the stored outcome. This refusal happens **before the key row is read** (the idempotency claim is a later claim than authorisation by design), so the replaying caller is indistinguishable from a first-time caller here; it records the ordinary D-9 authorisation-refusal audit row — **key-state-independent: one insert attempted per refused call, exactly one durable row when persistence succeeds** (a failed insert is logged and the refusal still returns — D-9's failure rule; T-042-bounded). See `REPLAY-AUTHZ-001`.
3. **Account status** — the involved account rows (the involvement set of the stored outcome: deposit → destination; withdrawal → source; transfer → source + destination) are re-read `FOR SHARE`, in ascending id, and each must still be **`ACTIVE`** (decision 11). A suspended/closed account that the caller **can still view** (stage 2 just re-confirmed that) returns the documented **409 `ACCOUNT_NOT_ACTIVE`** policy. The `FOR SHARE` status read serialises with a concurrent suspension/closure (whose row `UPDATE` conflicts with `FOR SHARE`), so replay-vs-suspension has **exactly two legal orders**; because the gate adds no new lock class and follows the declared order (session → users → grants → accounts), the lock graph remains the same cycle-free one as the normal money path.

Only when all three stages pass is the stored outcome returned (`replayed: true`). A gate refusal rolls the replay transaction back and **changes nothing stored**: the scoped key's existing records (its attempt row(s) and stored response) remain the complete, honest history of the original attempt — a **post-claim** refused replay (`KEY_REUSED`, or the gate's stage-(c) status refusal) never fabricates a second attempt row, while a replay refused **pre-claim**, at D-8 step 1b, is audited per the Authorisation-refusal path above (one D-9 insert attempted per refused call — exactly one durable FORBIDDEN row when persistence succeeds; a failed insert is logged and never suppresses the refusal) — and only *passed* replays are observable: **v1 records no replay-side writes** (no `replay_count`, no `idempotency_replays` table, no `IDEMPOTENT_REPLAY` audit row), so the only trace of a passing replay is the `replayed: true` field on that replay's response envelope; per-replay accounting is a deferred v2 idea requiring explicit human opt-in (`docs/adr/ADR-004-idempotency-and-refusals.md` §4).

## 4. What each attempt row is and is not allowed to store (Rev 2/3)

**Balance-availability matrix (nothing claims a balance it did not measure):**

| Code | `balance_at_attempt_minor` | Why |
|---|---|---|
| `INSUFFICIENT_FUNDS` | ✅ value read under the account lock | Refusal happens at the funds check, which runs only after `SELECT … FOR UPDATE` returned the row incl. balance |
| `ACCOUNT_NOT_ACTIVE` — source, or destination visible to the caller | ✅ value read under the account lock | Row (incl. balance) is already read under lock when the status check runs |
| `ACCOUNT_NOT_ACTIVE` — destination invisible to the caller | **NULL** | Refused under the destination's lock in the invisible-target path; the caller's envelope is uniform 404 and the caller is never shown a balance; the row itself stores the internal reason only |
| `INVALID_AMOUNT` | **NULL** | Ruled out in the **pre-lock** validation phase — no lock held, no balance read; a value here would be fabricated |
| `CURRENCY_MISMATCH` | **NULL** | Pre-lock phase |
| `SAME_ACCOUNT` | **NULL** | Pre-lock phase |
| `SYSTEM_ACCOUNT_NOT_ALLOWED` | **NULL** | Pre-lock phase; also under §3's target-visibility rule the external envelope to the caller stays uniform |
| `FORBIDDEN` / `ACCOUNT_NOT_FOUND` | **NULL** | Balance never read — the money transaction rolled back or never acquired it |
| `FAILED` (infra) | **NULL** | No authoritative outcome; nothing was measured |

Rule: `balance_at_attempt_minor` is set **only** from a balance read under the appropriate account row lock inside the same transaction. If there is any doubt the balance was measured, it is NULL. Clients/A8 statements render only non-NULL values.

**Common field rules:** actor id + role, operation, timestamp, reason, the supplied identifier `supplied_account_ref` (verbatim text) — always recorded when present. One structured `account_status_detail` field (`SUSPENDED`/`CLOSED`) may accompany `ACCOUNT_NOT_ACTIVE` rows written under lock (audit-clarity, not a free-text field). **`account_status_detail` visibility (approved decision 6): ADMIN/AUDITOR audit views only.** It is never included in any external HTTP response, never shown to holders or to any account-visible caller in the API surface, and does not appear as a statement field — statements show reason codes only; the detail lives in the internal row where admins/auditors inspect it. Request payloads/body fields — **never** recorded on any row.

## 5. Sequencing model (Rev 4): `accounts.event_last_seq` counter, `account_event_seq` per-entry values, `global_seq` tiebreak

**Approved naming (decisions 4+5): one counter, one shared per-entry column name, two consumers; audits never contend with the money path:**

1. **Shared per-account event sequence — `accounts.event_last_seq`** (integer counter on the account row). Per-account, gap-free, monotonic; allocated **only inside a transaction that holds that account's `FOR UPDATE` row lock**, by one atomic bump per event. Two row types consume it from the same namespace, and **both store the allocated value in a column named `account_event_seq`**:
   - **Ledger postings** — allocated value stored in **`ledger_entries.account_event_seq`**;
   - **Business refusals recorded inside the locked money transaction** — allocated value stored in **`transaction_attempts.account_event_seq`**.
   Values never collide (every allocation consumes the counter). A business refusal therefore occupies a *well-defined position inside the account's event stream*, between the same postings the branch executed around.
2. **Unsequenced rows (must NOT claim an event sequence or a balance):** every attempt recorded **outside** a locked-account context — pre-lock business refusals, `FORBIDDEN`/`ACCOUNT_NOT_FOUND` authorisation refusals, `FAILED` infra rows — carries `account_event_seq = NULL` and `balance_at_attempt_minor = NULL`. Nonexistent-account rows additionally carry a NULL account FK and only `supplied_account_ref` (AUTH-009). **Authorisation-refusal persistence (D-9):** one insert is attempted per refused call (key-state-independent — a replaying caller's refusal records identically to a first-time caller's, `REPLAY-AUTHZ-001`); exactly one durable row when persistence succeeds; a failed insert is logged, the refusal still returns, and T-042 bounds the volume.
3. **`global_seq`** — a dedicated, **non-transactional PostgreSQL SEQUENCE** (`nextval('attempt_global_seq')`): takes no row locks, cannot deadlock, is intentionally **non-gap-free** (documented). Every attempt row carries it; it is the total-order tiebreak for unsequenced rows and for admin audit views. The FAILED-recording transaction acquires only the attempt-table insert plus `nextval` (so a flood of FAILED rows cannot cause lock contention with healthy traffic); its insert is best-effort: on failure the error is logged, the response stands, nothing recurses (T-042 rate limiting bounds the volume).

**Statement rendering — exact rule (STMT-001/STMT-002): the merged timeline (approved decision 9).** The statement endpoint returns **one `timeline` array**; every row is labelled with its `category`:

- **`category: "event"`** — ledger postings **and** business refusals recorded under the account lock (`account_event_seq IS NOT NULL`). Among themselves, event rows are ordered strictly by `account_event_seq` ascending. Running balance is computed from postings only; a locked business refusal row shows its honestly-measured `balance_at_attempt_minor`, which reconciles with its neighbours.
- **`category: "attempt"`** — all refused attempts targeting the account **without** an event position (pre-lock business refusals; authorisation refusals), each flagged `event_position: null`. Among themselves, attempt rows are ordered by `(occurred_at, global_seq)`. Per A8 these include refusals targeting the account; `account_status_detail` never appears (§4).
- **Merge rule (single array):** two pre-ordered category lists are interleaved into the one array — list **A** = event rows in **`account_event_seq` ascending** (an order that comes from the counter, never from any clock), list **B** = attempt rows in `(occurred_at, global_seq)` ascending. The interleave is a single deterministic head-first pass: compare the current heads and take the earlier `occurred_at`; on an exact `occurred_at` tie the event row goes first. Each list is consumed strictly in order, so **no merge can ever reorder rows within a category**. Event `occurred_at` is still captured at the counter bump inside the account-lock critical section (recording the moment the event happened), but **wall-clock timestamps are not assumed monotonic**: a transaction that started earlier can still bump later (lock waits), and transaction-start-vs-bump-time differences or clock adjustments can make `occurred_at` disagree with `account_event_seq` order — across categories and even *within* the event category itself. `occurred_at` is therefore only the interleave signal between categories; when the stored timestamp evidence disagrees with the sequence discipline, **event order always follows `account_event_seq`, never the clock**.
- **Honesty guarantees the implementation must keep:** (1) the relative order of event rows in the array always equals their `account_event_seq` order — under **all** clock conditions, including non-monotonic/skewed `occurred_at` (STMT-001 asserts this with a skew fixture); (2) the relative order of attempt rows always equals `(occurred_at, global_seq)`; (3) no attempt row ever receives a sequence position — `event_position: null` is permanent; the timeline shows *when each row was recorded*, never a fabricated position inside the event stream; (4) `FAILED` rows are excluded from statements of every kind (admin audit view only); (5) the merge is deterministic — the same stored rows always produce the same array — **without assuming the clock ordered anything**.

The result is deterministic and reproducible (the same stored rows always produce the same output) **and honest** — one timeline for the reader, with the two approved ordering disciplines underneath it and no fabricated interleave.

**Invariants (INV-001):** gap-freeness is asserted over the **shared** counter — i.e. the union of allocated values across `ledger_entries.account_event_seq` and locked `transaction_attempts.account_event_seq` per account is gap-free and monotonic, and equals the sequence 1..`accounts.event_last_seq`; `global_seq` is deliberately non-gap-free and asserted only to be strictly-moving-per-value-used ordering; stored balances equal ledger-derived balances.

## 6. Statement & audit visibility — A8 policy (preserved)

| Viewer | Sees |
|---|---|
| Account holder with `VIEW` on account X | Every posting on X **and every refused attempt targeting X** — initiator, action, reason code (granular, e.g. `FORBIDDEN`), and `balance_at_attempt_minor` where an honest one was recorded; rendering follows §5's merged-timeline rule. **Never** attempts targeting other accounts, never request payloads, never another actor's accounts or balances. |
| Same holder, refuser side | Only the uniform 404 `ACCOUNT_NOT_FOUND` envelope — nothing about whether X or any other account exists, nor any classification (SYSTEM kind, status) of accounts the caller cannot view (§0/§3) |
| ADMIN / AUDITOR | Full authorised audit records: all attempt rows including internal `FORBIDDEN` / `ACCOUNT_NOT_FOUND` / `SYSTEM_ACCOUNT_NOT_ALLOWED` distinctions, `FAILED` infra rows, grant/role-change events and admin-lifecycle audit events (need-to-know per `AUTHZ_MATRIX.md`) |
| Any viewer | Never a `FAILED` row on an account statement; never a fabricated balance; never a request payload |

## 7. Gate 2 feedback → resolution map (review aid)

(_Rev 1 and Rev 2 maps below are kept verbatim for honest history; their `attempt_seq` terminology is superseded by the shared-counter model in §5 Rev 3._)

### Rev 1 (2026-11-06)

| Feedback item | Resolved in |
|---|---|
| 1. `LOCK_TIMEOUT` recording inconsistency | §1 (Infrastructure class) + §3 FAILED rows rule |
| 2. `VALIDATION_*` undefined | §2 (exact classification) + §3 (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `RATE_LIMITED`, removed the wildcard; no undefined `VALIDATION_*` family remains) |
| 3. `account_seq` for postings and attempts | §5 (formal, per-account, tested by INV-001) |
| 4. Malformed input vs business separation | §2 boundary rule (shape → transport; value → business) |
| 5. `FORBIDDEN`/`ACCOUNT_NOT_FOUND` indistinguishable | §0 + §3 (single 404 envelope; attempt rows keep the truth) |
| A8 policy preserved | §6 unchanged in substance |

### Rev 2 (2026-11-07)

(Finding numbers are per each review round — Rev 2 had four findings.)

| Feedback item | Resolved in |
|---|---|
| 3 (rev 2). INVALID_AMOUNT balance contradiction | §2 canonical validation order + §4 balance-availability matrix (pre-lock refusals carry `balance_at_attempt_minor = NULL`) |
| 4 (rev 2). Infrastructure audit sequencing | §3 FAILED-rows note + §5 tier 3: best-effort short transaction touching only the attempt table; independent non-transactional `global_seq` SEQUENCE (no row locks → no contention/deadlock during lock-timeout recovery); FAILED volume rate-limited (T-042) |
| 2 (rev 2). AUTH-009 nonexistent-account audit | §3 ACCOUNT_NOT_FOUND row + §5: NULL `account_id` FK/`attempt_seq`, verbatim `supplied_account_ref`, true internal reason, uniform external 404 untouched; persistence test AUTH-009 |
| Clarification. Session revocation linearisation | Defined in `AUTHZ_MATRIX.md` §D.3a; test SESS-001 |

### Rev 3 (2026-11-07)

(Finding numbers follow the Rev 3 review's nine findings.)

| Feedback item | Resolved in |
|---|---|
| 2. Statement event ordering | §5 rewritten: one shared per-account `account_event_seq` counter (postings as `account_seq`, locked refusals as `event_seq`), exact two-part rendering rule; pre-lock/nonexistent rows claim no event seq/balance; INV-001 updated to the shared-namespace assertion |
| 3. Business-refusal wording | §1 business row no longer implies a measured balance; §4 matrix remains the per-code authority |
| 4. SYSTEM destination disclosure | §3 target-visibility rule: uniform 404 envelope for all non-account-visible targets (absent/forbidden/inactive/SYSTEM); internal rows keep exact reasons; granular 409 only for account-visible callers (admin cash-desk); tests DEST-001 + AUTH-007 + TIMING-001 |
| 5. Account status enum | §3 `ACCOUNT_NOT_ACTIVE` row + §4 `account_status_detail`; enum and transitions defined in `AUTHZ_MATRIX.md` §F (incl. zero-balance close precondition, `NONZERO_BALANCE` code) |
| 8. Uniform response timing | §0 + §3: identical status/body are hard requirements; latency is mitigated and checked statistically (TIMING-001), no absolute identical-latency promise |
| 9. Unsafe JSON integer handling | §2 integer-precision rules: raw-token grammar, direct `BigInt(tokenString)` conversion (never via `Number`), 64-bit range bound → `VALIDATION_FAILED`; string serialisation for all money JSON fields; threat T-049; test AMT-001 |
| 1 (cross-ref). Lock-order consistency | Lock-order corrections live in `AUTHZ_MATRIX.md` §C.2/§D/§D.6 (sessions before users in admin lifecycle, ascending-ID session ordering); attempt-event sequencing implications are §5 here |

### Rev 4 (2026-11-07 — human's approved decision set)

| Approved decision | Resolved in |
|---|---|
| 5. Per-entry sequence named `account_event_seq` | §5: both `ledger_entries.account_event_seq` and `transaction_attempts.account_event_seq` share the one column name, allocated from `accounts.event_last_seq`; `last_seq`/`account_seq`/`event_seq` names superseded in all normative text |
| 9. One merged statement timeline | §5 merged-timeline rule: `occurred_at` first, events-before-attempts on ties, event `occurred_at` captured at the counter bump under the account lock; four honesty guarantees stated (no fabricated positions for attempt rows) |
| 6. `account_status_detail` ADMIN/AUDITOR only | §4 field rules made explicit (never external, never to holders) |
| 7. TIMING-001 best-effort, non-gating | §0 latency cell + §3 |

(_Post-Rev-4 correction, same round: the §5 merge rule was revised so it no longer assumes wall-clock `occurred_at` is monotonic or that timestamp order matches `account_event_seq` — internally ordered lists + a deterministic head-first interleave now define the timeline. The row-9 wording above is kept as originally written; §5 is the normative rule._)
