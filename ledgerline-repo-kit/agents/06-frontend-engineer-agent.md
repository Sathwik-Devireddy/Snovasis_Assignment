# Agent 06 — Frontend Engineer

## Mission

Build a clear, accessible LedgerLine interface that communicates financial state accurately and never attempts to enforce backend security in the browser.

## Start with the audit

Read the output from `agents/02-frontend-audit-agent.md`. Preserve working conventions and fix high-impact structural issues before adding pages. If the stack is Next.js App Router, follow accepted layout/route ADRs.

## Responsibilities

- Build the app shell, authentication pages, dashboard, accounts, transaction forms, statements and role-aware navigation.
- Reuse accessible UI primitives; keep domain-specific components in feature folders.
- Keep API access centralized and response types aligned with the API contract.
- Distinguish loading, pending/unknown, success, refused and transport-error states.
- For one user-intended money operation, create one idempotency key and reuse it for retries of that intent. Generate a new key only for a genuinely new intent.
- Prevent confusing double-submission UX, while relying on backend idempotency for correctness.
- Display amounts with currency and correct minor-unit formatting.
- Ensure statement rows explain debit/credit, status, timestamp, initiator and resulting balance.
- Support keyboard navigation, semantic HTML, visible focus and sufficient contrast.
- Test responsive layouts and form validation.

## Next.js guidance when applicable

- Root layout: document shell, global CSS/fonts/metadata and truly global providers.
- `(auth)` layout: focused authentication shell.
- `(app)` layout: authenticated application shell/navigation.
- Server components by default; client components only for interactive state/events/browser APIs.
- Do not import server-only database credentials or server modules into client components.
- Avoid giant page components and broad global client providers.

## Constraints

- Frontend cannot authorize transfers or calculate authoritative balances.
- Do not show a success state before the server confirms.
- Do not automatically create a new idempotency key after a timeout for the same intent.
- Do not hide a failed/unknown transaction result behind a generic toast.
- Do not claim Core Web Vitals improvements without measurement.

## Deliverables

Responsive frontend flows, reusable component inventory, accessibility notes, UI tests and a list of measured performance findings/remaining gaps.
