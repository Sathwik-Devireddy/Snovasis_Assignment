---
name: frontend-design
description: UI principles for LedgerLine: restrained, legible, accessible money screens with honest pending/refused/unknown states. Use when building or reviewing any page or component in apps/web.
---
# LedgerLine frontend design

Goal: a calm, trustworthy interface where a person can tell exactly what happened to their money. Clarity beats decoration.

## Principles
- **Hierarchy:** balance and the primary action first; secondary detail (statement, metadata) below. One primary button per view.
- **Numbers:** right-aligned, tabular figures (`font-variant-numeric: tabular-nums`), currency symbol and fixed two decimals, debits and credits distinguished by label and sign, never by colour alone.
- **Tokens:** define colour, spacing, radius and type scale once (CSS variables). Light and dark. Contrast at least WCAG AA. Visible focus rings.
- **Components:** shared primitives (Button, Input, Select, Table, Badge, Alert, Dialog, PageHeader) in `components/ui`; domain components in feature folders. No duplicated variants.
- **Forms:** real `<label>`s, inline validation messages tied with `aria-describedby`, amount typed as text and parsed to integer paise by string handling (never float), explicit confirmation step for money movement.
- **States, always all of them:** loading (skeleton), empty (explain next step), error (what failed, what to do), pending (disabled submit, status text), success (server-confirmed only), **refused** (reason code in plain words), **unknown** (network timeout: "We could not confirm this. Retrying is safe." with a retry that reuses the same idempotency key).
- **Honesty:** never show success before the server confirms; never present a client calculation as the authoritative balance; refresh balance from the server after each operation.
- **Role-aware UI** (navigation, hidden buttons) is convenience only; every screen must still render a sensible "not allowed" state when the API refuses.
- **Responsive:** works at 360px width; tables become stacked rows or scroll in a labelled region; touch targets at least 44px.
- **Next.js:** server components by default; client components only for interactive forms; route groups `(auth)` and `(app)`; one API client module; no server secrets in client bundles.

## Anti-patterns to reject
Decorative gradients over data, colour-only status, toast-only error reporting for money operations, auto-generating a new idempotency key on retry, floating-point amount maths, giant page components mixing fetching, layout and rules.

## Check before done
Keyboard-only walkthrough of login → transfer → statement; screen-reader names on every control; 360px screenshot; all seven states exercised in a test or story.
