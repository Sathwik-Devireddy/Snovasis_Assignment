"use strict";

/**
 * Migration 0005 — accounts INSERT grant for the runtime role.
 *
 * Closes the gap between the drafted grant block in `docs/schema-draft.sql`
 * (SELECT + column-level UPDATE only) and the committed API contract
 * (`POST /api/v1/accounts` — Admin, AC2.1: "account creation is admin-only and
 * writes the account with currency, kind and zero balance").
 *
 * The drafted grants were written before the BalanceVault expansion fixed the
 * account-creation surface; without INSERT the runtime role cannot serve the
 * contracted endpoint at all. Authorisation stays application-enforced
 * (ADMIN-only handler, audited); the grant does not widen money authority:
 * the runtime role still has NO DELETE, NO UPDATE outside the decided column
 * list, and account rows themselves are never deleted (close is a status
 * transition, §F).
 *
 * Also normalises the EXTERNAL_CLEARING seed currency to INR (v1 is an
 * INR-only system per REFUSAL_CODES §2 — the 0004 seed predates that check
 * being wired into the money path and never shipped in a commit).
 */

function sql(statement) {
  return statement.trim();
}

async function up(pgm) {
  pgm.sql(sql("GRANT INSERT ON accounts TO ledgerline_app"));
  pgm.sql(sql(
    "UPDATE accounts SET currency_code = 'INR' " +
    "WHERE account_number = 'EXTERNAL_CLEARING' AND currency_code <> 'INR'"
  ));
}

async function down(pgm) {
  pgm.sql(sql("REVOKE INSERT ON accounts FROM ledgerline_app"));
}

module.exports = { up, down };
