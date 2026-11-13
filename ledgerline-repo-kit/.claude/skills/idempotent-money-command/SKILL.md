---
name: idempotent-money-command
description: The exact transaction flow for deposits, withdrawals and transfers with idempotency, locking and refusal recording. Use when writing or reviewing moneyCommandRunner or any money use case.
---
# Idempotent money command

Order inside ONE transaction:
1. Authenticate + authorise **inside** the transaction: re-read the actor's session row `FOR SHARE` first — the first money-path lock, before `users` (SESS-001/T-048; a concurrently revoked session fails here with 401 `UNAUTHENTICATED`) — then read the actor's `users` row and the grant rows for the target accounts `FOR SHARE`, in ascending id (ADR-007; linearised with revocation). Global lock order: actor's session row → actor's `users` row → grants → idempotency key claim (a **unique INSERT, not a lock step** — no `FOR UPDATE` is taken; a concurrent duplicate waits on the uncommitted unique entry via the uniqueness conflict until the winner commits/rolls back, ADR-003) → accounts (ascending ids; `docs/AUTHZ_MATRIX.md` §D.6). On refusal: ROLLBACK, then record a REFUSED/FORBIDDEN attempt in a separate short audit transaction; no idempotency row.
2. `INSERT INTO idempotency_records (actor_id, operation, key, request_hash) … ON CONFLICT DO NOTHING`.
   - Inserted → continue.
   - Conflict → PostgreSQL waits on the uncommitted winner, then read the row:
     different hash → 409 `KEY_REUSED` (canonical conflict code);
     same hash → **replay gate** (evaluation only, in this same transaction: NO writes, NO counter
     bump, NO new attempt rows, declared lock order unchanged — `docs/REFUSAL_CODES.md` §3
     (the "no new attempt rows" vow covers the gate pass and post-claim refusals;
     pre-claim step-1b refusals attempt the D-9 audit insert — one durable row when
     persistence succeeds, a failed insert is logged — approved DEC-1 scope)
     "Replay re-evaluation gate"). The stored response (`replayed: true`) returns only after
     every stage passes:
       a. session validity — already enforced at step 1 (`FOR SHARE` re-read): a concurrently
          revoked/expired session failed there with **401 `UNAUTHENTICATED`** (never a 404/409)
          and can never reach a stored response;
       b. grant/visibility — step 1 also read the target grant rows `FOR SHARE` fresh
          (linearised with revocation): a grant revoked or visibility lost since the original
          attempt already refused at step 1 with the single uniform
          **404 `ACCOUNT_NOT_FOUND`** envelope;
       c. account status — re-read the involved customer account rows `FOR SHARE`, ascending id
          (involved set = deposit destination / withdrawal source / transfer source + destination),
          and require `ACTIVE` on each (decision 11): a suspended/closed but still-viewable
          account → **409 `ACCOUNT_NOT_ACTIVE`** (granular for a visible destination). The
          `FOR SHARE` read serialises with a concurrent suspension/closure — exactly two legal
          orders, no new lock class, no cycle.
     Gate refusal → ROLLBACK (nothing stored changes); gate pass → COMMIT, then return the
     stored response.
3. **Pre-lock semantic checks** — BEFORE any account-row lock or balance read (`docs/REFUSAL_CODES.md` §2 canonical order): same-account, currency, amount validity (≤ 0 / over cap → `INVALID_AMOUNT`), destination kind. A refusal commits: attempt row with NULL balance and NULL `account_event_seq`; the key row stores the refusal as the replayable outcome.
4. Lock customer account rows `ORDER BY id FOR UPDATE` (never SYSTEM accounts). Read balance **after** the lock.
5. **Under-lock checks**: status ACTIVE on source and destination (SUSPENDED blocks both directions — decision 11), then sufficient funds. Insufficient/inactive funds refusal: write `transaction_attempts` (REFUSED, reason_code) with the under-lock-read balance and an allocated `account_event_seq`, store the refusal on the key row, **commit**.
6. Insert journal and entries; update balance and `event_last_seq` (each event bumps `accounts.event_last_seq`).
7. Store the response on the idempotency row — the **semantic-replay artifact**: status + business body, money/sequence values as JSON strings; NOT a byte-image of the first response (JSONB normalises key order/whitespace; ADR-004 §1a). COMMIT.
- Infrastructure error: roll back; the key is not consumed; best-effort FAILED attempt in a separate transaction. Never keep using a transaction after a failed statement.
- 40P01 / 40001: retry the whole command up to 3 times with the same key.
- Key scope is `(actor, operation, key)`; replay requires the same authenticated actor.
- Claim in docs and interview: *at most one financial effect per scoped key, with replay of the stored outcome*. Not "exactly once".
