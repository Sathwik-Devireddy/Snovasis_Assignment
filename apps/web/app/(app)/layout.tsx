"use client";

import "@/app/globals.css";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>BalanceVault</title>
      </head>
      <body>
        <nav>
          <span className="brand">BalanceVault</span>
          <a href="/app/accounts">Accounts</a>
          <a href="/app/transfer">Transfer</a>
          <a href="/app/withdrawal">Withdrawal</a>
          <a href="/app/deposit">Deposit (Admin)</a>
          <a href="/app/admin/accounts">Admin: Users</a>
          <a href="/app/admin/permissions">Admin: Permissions</a>
          <a href="/app/auditor/audit">Audit Events</a>
          <a href="/app/auditor/reconciliation">Reconciliation</a>
          <button className="logout" onClick={() => { document.cookie = "bv_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"; window.location.href = "/login"; }}>Sign out</button>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
