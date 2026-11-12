/**
 * Main application layout (PHASE-11 P11.6).
 *
 * Role-aware navigation is convenience only — the API enforces all
 * authorisation. Links shown here are a superset; non-permitted callers
 * receive uniform 404s from the server.
 *
 * The root `app/layout.tsx` renders <html>/<body>; nested layouts must not
 * repeat document shells. Global styles are imported once in the root layout.
 */

import Link from "next/link";
import SignOutButton from "./sign-out-button";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav aria-label="Main navigation">
        <span className="brand">BalanceVault</span>
        <Link href="/accounts">Accounts</Link>
        <Link href="/transfer">Transfer</Link>
        <Link href="/withdrawal">Withdrawal</Link>
        <Link href="/deposit">Deposit (Admin)</Link>
        <Link href="/admin/accounts">Admin: Users</Link>
        <Link href="/admin/permissions">Admin: Permissions</Link>
        <Link href="/auditor/audit">Audit Events</Link>
        <Link href="/auditor/reconciliation">Reconciliation</Link>
        <SignOutButton />
      </nav>
      <main>{children}</main>
    </>
  );
}
