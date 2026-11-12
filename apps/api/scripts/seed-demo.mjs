#!/usr/bin/env node
/**
 * Demo seed — one synthetic user per role + demo accounts (PHASE-13 P13.2).
 *
 * Idempotent by construction (T-044 / SEED-001): every insert is keyed on a
 * DETERMINISTIC identifier (email / account_number) with ON CONFLICT DO
 * NOTHING, and every money movement uses a FIXED idempotency key — so
 * running the script twice (CI, an operator's second attempt) can never
 * double-post a deposit or a transfer: the API replays the stored result.
 *
 * Usage:
 *   node --env-file=.env apps/api/scripts/seed-demo.mjs
 *
 * Required environment:
 *   DATABASE_URL        — runtime role (ledgerline_app)
 *   DEMO_SEED_PASSWORD  — password for the synthetic demo users (demo-only)
 *
 * Optional environment:
 *   DEMO_API_URL        — API origin for the synthetic ledger movement
 *                         (default http://localhost:4000; skipped when the
 *                         API is unreachable)
 *   DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD — the bootstrap-created admin used
 *                         to post the synthetic deposits/transfers
 *
 * The FIRST administrator is NOT created here: that is the controlled
 * bootstrap process (`apps/api/scripts/bootstrap.mjs`, T-015).
 */

import { Client } from "pg";

const DEMO_USERS = [
  { email: "demo.holder@balancevault.local", role: "ACCOUNT_HOLDER" },
  { email: "demo.auditor@balancevault.local", role: "AUDITOR" },
];

const DEMO_ACCOUNTS = [
  { accountNumber: "DEMO-HOLDER-ACCOUNT", label: "Demo holder account" },
  { accountNumber: "DEMO-COUNTER-ACCOUNT", label: "Demo counter account" },
];

// Fixed idempotency keys → a second run replays instead of moving money.
const DEPOSIT_KEY = "demo-seed-deposit-0001";
const TRANSFER_KEY = "demo-seed-transfer-0001";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`[seed-demo] ${name} is required — refusing to seed with a guess.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const password = required("DEMO_SEED_PASSWORD");
  const apiUrl = (process.env.DEMO_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const accountIds = new Map();

  try {
    // ---- users (idempotent: the email is the natural key) --------------------
    const { hash } = await import("argon2");
    const encoded = await hash(password, { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const user of DEMO_USERS) {
      const { rowCount } = await client.query(
        `INSERT INTO users (email, password_hash, role, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (email) DO NOTHING`,
        [user.email, encoded, user.role],
      );
      console.log(
        rowCount === 1
          ? `[seed-demo] created ${user.role} ${user.email}`
          : `[seed-demo] ${user.email} already exists — skipped`,
      );
    }

    // ---- accounts (idempotent: the account_number is the natural key) -------
    for (const account of DEMO_ACCOUNTS) {
      const { rowCount } = await client.query(
        `INSERT INTO accounts (account_number, label, currency_code, kind, balance_minor, event_last_seq, status)
         VALUES ($1, $2, 'INR', 'CUSTOMER', 0, 0, 'ACTIVE')
         ON CONFLICT (account_number) DO NOTHING`,
        [account.accountNumber, account.label],
      );
      console.log(
        rowCount === 1
          ? `[seed-demo] created account ${account.accountNumber}`
          : `[seed-demo] account ${account.accountNumber} already exists — skipped`,
      );
    }

    for (const account of DEMO_ACCOUNTS) {
      const { rows } = await client.query(
        "SELECT id::text AS id FROM accounts WHERE account_number = $1",
        [account.accountNumber],
      );
      accountIds.set(account.accountNumber, rows[0]?.id);
    }

    // ---- grants (idempotent) ------------------------------------------------
    // The demo HOLDER needs TRANSFER/VIEW/WITHDRAW on the demo accounts: a
    // transfer requires a TRANSFER grant on the source for EVERY actor, and
    // an administrator may never grant a permission to themself (AUTH-004) —
    // so the seed (an operator action, like the admin UI) grants the holder.
    if (adminEmail !== undefined) {
      const { rows: adminRows } = await client.query("SELECT id::text AS id FROM users WHERE email = $1", [
        adminEmail,
      ]);
      const { rows: holderRows } = await client.query(
        "SELECT id::text AS id FROM users WHERE email = $1",
        [DEMO_USERS[0].email],
      );
      const adminId = adminRows[0]?.id;
      const holderId = holderRows[0]?.id;
      if (adminId !== undefined && holderId !== undefined) {
        for (const account of DEMO_ACCOUNTS) {
          const accountId = accountIds.get(account.accountNumber);
          for (const permission of ["VIEW", "TRANSFER", "WITHDRAW"]) {
            await client.query(
              `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [holderId, accountId, permission, adminId],
            );
          }
        }
        console.log("[seed-demo] granted VIEW/TRANSFER/WITHDRAW on the demo accounts to the demo holder");
      }
    }
  } finally {
    await client.end();
  }

  // ---- synthetic ledger movement (through the REAL money path) ---------------
  if (adminEmail === undefined || adminPassword === undefined) {
    console.log(
      "[seed-demo] DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD not set — users and accounts seeded, synthetic ledger movement skipped.",
    );
    return;
  }

  let cookie = "";
  try {
    const login = await fetch(`${apiUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    if (!login.ok) {
      console.log(`[seed-demo] admin login failed (${login.status}) — ledger movement skipped.`);
      return;
    }
    const setCookie = login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
  } catch {
    console.log(`[seed-demo] API unreachable at ${apiUrl} — ledger movement skipped.`);
    return;
  }

  // The demo holder performs the transfer (a TRANSFER grant is required on
  // the source account for every actor).
  let holderCookie = "";
  try {
    const login = await fetch(`${apiUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: DEMO_USERS[0].email, password }),
    });
    if (login.ok) {
      const setCookie = login.headers.get("set-cookie") ?? "";
      holderCookie = setCookie.split(";")[0] ?? "";
    }
  } catch {
    holderCookie = "";
  }

  const post = async (path, body, key, sessionCookie) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "idempotency-key": key },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text };
  };

  const source = accountIds.get("DEMO-HOLDER-ACCOUNT");
  const destination = accountIds.get("DEMO-COUNTER-ACCOUNT");

  const deposit = await post(
    `/accounts/${source}/deposits`,
    { amountMinor: "250000", currencyCode: "INR" },
    DEPOSIT_KEY,
    cookie,
  );
  console.log(`[seed-demo] deposit (admin) → ${deposit.status} ${deposit.body}`);

  if (holderCookie !== "") {
    const transfer = await post(
      "/transfers",
      { sourceAccountId: source, destinationAccountId: destination, amountMinor: "50000", currencyCode: "INR" },
      TRANSFER_KEY,
      holderCookie,
    );
    console.log(`[seed-demo] transfer (holder) → ${transfer.status} ${transfer.body}`);
  } else {
    console.log("[seed-demo] demo holder could not log in — the transfer was skipped.");
  }

  console.log(
    "[seed-demo] done. Re-running is safe: fixed account numbers and fixed idempotency keys replay instead of double-posting (T-044 / SEED-001).",
  );
}

main().catch((error) => {
  console.error("[seed-demo] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
