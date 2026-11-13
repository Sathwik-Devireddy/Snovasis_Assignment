# Phase 11: Frontend and accessibility

**Target:** Tue 10 Nov. **Agents:** 02 frontend audit (read-only, first), 06 frontend engineer. **Skills:** clean-architecture-guard, frontend-design.

## Objective
Clear, honest UI over a finished API. The UI never decides anything financial.

## Tasks
- [ ] P11.1 Run agent 02 on the scaffold you have; apply only accepted findings.
- [ ] P11.2 Route groups `(auth)` and `(app)`; layouts per ADR; API client in one module with normalised errors; Next rewrites `/api/*`.
- [ ] P11.3 Pages: login, dashboard/accounts, account detail with statement, deposit/withdraw/transfer forms — the **deposit form is rendered for ADMIN only** (H-2: holders have no deposit path; do not show a form that can only fail); admin (accounts, permissions), auditor (audit events, reconciliation).
- [ ] P11.4 One intent = one idempotency key (generated when the form opens, kept across retries, regenerated only after a definitive result and a new form). States: idle, pending, success, refused (with reason), **unknown** (timeout; offer retry with the same key).
- [ ] P11.5 Amount input converts rupees to integer paise with string parsing, not floats; tests for `0.1 + 0.2` style cases. Displayed server money/sequence values are rendered **exactly as received (JSON strings)** — never re-parsed through `Number`, mirroring the API serialization convention (`docs/API_CONTRACT.md`).
- [ ] P11.6 Role-aware navigation (convenience only). Empty, loading, error states. Keyboard, labels, focus, contrast, mobile widths.
- [ ] P11.7 Playwright smoke: login per role, transfer, statement, forbidden screen.
- [ ] P11.8 A visible "recently refused / duplicate replay" indicator so a judge sees the idempotency outcome.

## Acceptance (Gate 11)
Core flows work on desktop and phone width; no financial rule exists in `apps/web`.

## Closeout
`PROMPTS.md` entry (frontend or testing). Suggested commit: `feat(web): transfer flow with stable idempotency key`.
