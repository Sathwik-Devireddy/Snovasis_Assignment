# Phase 10: Statements, audit view and reconciliation

**Target:** Mon 9 to Tue 10 Nov. **Agents:** 05 backend, 07 security. **Skills:** ledger-posting, api-doc-sync.

## Tasks
- [ ] P10.1 `GET /accounts/:id/statement`: one merged `timeline` per `docs/REFUSAL_CODES.md` §5 — event rows (postings + locked refusals) ordered by `account_event_seq` (the counter, **never the wall clock** — `occurred_at` is not assumed monotonic), unsequenced attempt rows `event_position: null` ordered by `(occurred_at, global_seq)`, interleaved by a deterministic head-first merge of the two pre-ordered lists (earlier `occurred_at` first; exact tie → event first) that **preserves each category's order under all clock conditions** and **no fabricated sequence positions**; keyset pagination; each row shows type, direction, amount, `balance_after`, initiator (id and display name), timestamp, status, reason code (money/sequence fields serialised as JSON strings); never `account_status_detail` for holders (ASD-001). Attempts do not fabricate postings.
- [ ] P10.2 Access: holder sees only their accounts; auditor all, read-only; admin all. Non-permitted users get a uniform 404.
- [ ] P10.3 `GET /audit/events` (auditor/admin): attempts, grants, replays, logins (no secrets).
- [ ] P10.4 `GET /reconciliation/accounts/:id` and a global `/reconciliation/summary`: stored vs ledger-derived, conservation totals.
- [ ] P10.5 Tests: STMT-001 ordering under concurrent commits **and with skewed/non-monotonic `occurred_at` fixtures** (event order follows the counter, not the clock), running balance recomputation, AUD-001, pagination without gaps/duplicates, INV-001.
- [ ] P10.6 Optional stretch (H-5): per-account hash chain written under the account lock and verified by reconciliation; test that a superuser edit is detected.

## Acceptance (Gate 10)
An auditor can reconstruct every balance from the statement alone, and cannot mutate anything.

## Closeout
Update T-011, T-033, T-037. `PROMPTS.md` entry (audit trail).
