# Write-up — LedgerLine / BalanceVault

*What was built, what was deliberately left out, how the money model actually
holds, how AI was used, and what is still unfinished.*

## 1. What this is

A small double-entry ledger application. Money enters through a deposit
(external money-in at an admin cash desk), moves between customer accounts by
transfer, and leaves through a withdrawal. Every one of those movements is a
**balanced journal**: two postings, equal and opposite, committed in one
database transaction. Nothing in the system can set a balance by writing a
number.

The interesting part is not the CRUD — it is the set of properties that make
the money correct under concurrency, retries and partial failures.

## 2. The integrity model, in our own words

**Double entry is a database invariant, not a convention.** Every journal must
balance, and a deferred trigger pair (`assert_journal_balanced`) re-checks it
at COMMIT: a zero-entry journal, a one-entry journal, an unbalanced journal and
a cross-currency journal are all rejected at the moment of commit, not by a
code path that could be forgotten. The application code builds balanced
journals; the database refuses to store an unbalanced one.

**A transaction is one transaction.** Every financial operation — deposit,
withdrawal, transfer — is exactly one raw-`pg` transaction that owns
everything: the idempotency claim, the balance check, the account locks, the
journal, the two ledger entries, the cached balance update and the attempt
row. Prisma is used for routine non-financial CRUD (users, sessions, grants,
audit reads) and never touches a financial statement; a financial operation is
never split across a Prisma transaction and a raw transaction. That single
rule removes an entire class of "it committed here but not there" failures.

**Overdraft is prevented by locking, not by hoping.** A withdrawal takes the
account row `FOR UPDATE`, ascending by id (a deterministic order, so two
opposite-direction transfers cannot deadlock), and checks the balance *inside*
that lock. A read-then-write check without a lock would allow two concurrent
withdrawals to both read the same balance and both succeed. We proved that
claim by removing the lock and watching the test fail: both withdrawals
succeeded, and the database's own `balance_minor >= 0` CHECK was the only
thing left standing.

**Duplicates are refused by the database, not by a disabled button.** An
idempotency key is scoped to `(actor, operation, key)` with a UNIQUE
constraint. The first request claims the key inside the transaction; a
concurrent twin loses the claim and replays the stored result. The same key
with a *different* payload is refused (`KEY_REUSED`) — reusing a key for
something else is a client bug, not a new intent. Business refusals do not
consume the key; infrastructure failures do not consume it either, so a retry
after a timeout can safely reuse the same key. The frontend therefore never
mints a new key for a retry, and never shows an unknown outcome as a confirmed
refusal.

**History is append-only, enforced by the database.** The runtime role has no
UPDATE and no DELETE on the ledger, the journal, the audit log or the attempt
rows, and row-level plus TRUNCATE triggers fire for every session — including
the privileged owner role. Corrections are compensating journals, never edits.
The only bypass is a deliberate `ALTER TABLE … DISABLE TRIGGER` by the owner,
and that is disclosed in the threat register rather than hidden.

**SYSTEM accounts are not customer accounts.** `EXTERNAL_CLEARING` is the
external money boundary. It carries **no cached balance** (a database CHECK
enforces that), so any calculation that reads cached balances for the clearing
side reads zero and reports a conservation failure that does not exist. The
reconciliation surface therefore derives *both* sides from the ledger
(`Σcredits − Σdebits`): the customer total and the clearing position. The
global invariant is that those two sums cancel exactly.

**Money never becomes a float.** Amounts are integer paise carried as decimal
strings end to end. The API validates the raw JSON token against a strict
integer grammar and the signed 64-bit range *before* it reaches the database,
and it rejects an id above `9223372036854775807` before PostgreSQL can turn
it into a driver error. Every money and sequence field leaves the API as a
string.

**The cache is derived; the ledger is authoritative.** The cached balance on an
account row is an optimisation. The invariant checker compares it with the
ledger-derived total and reports a mismatch rather than correcting it — the
reconciliation endpoint does the same. When a mutation experiment
deliberately broke a guard, the checker is what noticed the drift.

**Rate limiting is an availability control, never a financial control.**
Redis holds no balance, ledger, idempotency or authority state. If Redis
dies, traffic continues, health reports the degradation, and the database
side caps remain authoritative. A financial application that loses correctness
when its cache dies has mis-drawn the line.

**Refusals are explained, without leaking.** A business refusal is a
committed outcome row (`transaction_attempts`), not a vanished transaction. The
external envelope is uniform: a caller who may not see an account receives
the same 404 as a caller looking for an account that does not exist, and the
internal truth stays in the attempt row.

## 3. What was deliberately left out

- **No JWT, no OAuth, no SSO.** Sessions are opaque random tokens, stored
  hashed, carried in an HttpOnly cookie. Revocation is a database predicate.
  The bootstrap/rotation operator identity is a *claim*, not proof — accepted
  and documented as T-050.
- **No floating-point, ever.** No `Number` on a monetary value.
- **No partial money movement.** There is no "adjust balance" endpoint and no
  way to write a balance directly; an adjustment would be a compensating
  journal.
- **No automatic anomaly detection or AI in the money path.** Phase 15 is
  deliberately untouched.
- **No retry middleware in the database layer.** Retries are explicit,
  bounded (three attempts) and only for the codes that are provably safe to
  retry.

## 4. How AI was used, and where it was wrong

AI did most of the drafting: architecture documents, ADRs, the schema, the
route layer, the test suites, the documentation. It was also wrong in ways
that mattered, and those corrections are the interesting part:

- A first adversarial "test file" contained placeholder assertions that always
  passed — fake verification dressed as a test. It was deleted, not "fixed".
- The money pages rebuilt the retry body from live form fields, so an edited
  form turned a retry into a different payload under the same key — answered
  `409 KEY_REUSED` and shown to the user as a *confirmed refusal* for a
  transaction that might already have committed. An independent review caught
  it; the key is now bound to the payload.
- The API's CSRF origin guard compared `Origin` with `Host`. The Next.js
  rewrite proxies with `changeOrigin: true`, so the browser's host never
  reached the API — and **every** browser mutation was rejected with 400. The
  previous test suite never noticed, because it exercised the API directly and
  never sent an `Origin` header. The fix is an explicit origin allow-list
  (`APP_ORIGIN`, required in production).
- The compiled API could not start: the start script pointed at a path that
  did not exist, and the generated Prisma client was never emitted into
  `dist`. Nothing in the unit tests would ever have caught this.

Every correction is recorded in `PROMPTS.md` with the prompt, the output, the
defect, how it was verified and the commit that fixed it.

## 5. Verification performed

- API: **26 files / 200 tests** against a real PostgreSQL 17 and Redis 8 —
  including concurrency races, forced deadlock retry, idempotency replay,
  statement ordering, reconciliation conservation, audit atomicity under
  injected audit failure, eight adversarial API attacks and a 200-request load
  smoke that ends with the global invariants checked.
- Web: **4 files / 41 tests** (money parsing, error classification, the
  intent/key model, logout outcome).
- Mutation checks executed against the running database: three guards removed,
  the named test observed failing, every guard restored and re-verified green.
- Deployment shape: the compiled API boots and serves `/health` and `/ready`;
  the browser journey was verified through the real proxy (register → login →
  accounts → deposit → statement → logout → 401).
- CI is green on both jobs (API + web).

## 6. Unfinished work

1. **No production deployment yet** — the deployment steps and the environment
   contract are documented and the artefacts boot locally, but there is no live
   URL, no HTTPS and no verification "from outside your session".
2. **No browser end-to-end suite** — the user journey was verified manually
   through the real proxy; a Playwright suite would make that repeatable.
3. **T-063 (postcss advisories via `next@15.5.29`)** — build-time only; the
   only fix npm offers is a major Next upgrade, which was not attempted inside
   the submission window. It needs an owner decision.
4. **T-017 / T-018 / T-020 / T-038** remain open (idempotency expiry, database
   failure injection mid-operation, timing side channel, replay after a long
   delay). Each is recorded with its condition; none of them is silently
   ignored.
5. **The T-042 attempt-write cap is best-effort**, not a strict hard cap — the
   count and the insert are not serialised. It is an abuse bound, never a
   financial invariant, and it is documented as such in both the code and the
   threat register.
6. **The `LOGIN_FAILED` audit row is written best-effort** — a failure is
   logged and the uniform 401 is preserved, because degrading that envelope
   would be worse than losing the row.

## 7. What a reviewer should try first

1. Break the overdraft protection: remove the `FOR UPDATE` lock and run
   `CON-001` — both withdrawals succeed.
2. Break idempotency: drop `idempotency_scope_unique` and run `IDEM-003` — the
   key claim disappears.
3. Attack the API directly: `apps/api/test/integration/phase12Adversarial.test.ts`
   runs eight attacks (overdraw race, replayed transfer, another user's
   account, auditor writes, holder deposit, role in the body, tampered cookie,
   cross-origin mutation) against the real handlers.
4. Try to make a browser mutation work through the rewrite — it now does, and
   the origin allow-list is the thing that decides it.
