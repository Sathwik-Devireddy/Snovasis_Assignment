"use strict";

/**
 * Migration 0006 — the account_permissions.account_id foreign key.
 *
 * Migration 0002 states the intent explicitly: "P5.1 FK note:
 * `account_permissions.account_id` references the `accounts` table, which
 * arrives in Phase 6 (schema-draft order); the FK is stubbed here and added
 * by the Phase-6 migration in the same change-set as `accounts`." The Phase-6
 * migration (0003_ledger.js) created `accounts` but never added the
 * constraint, so the table has been running WITHOUT the foreign key ever
 * since — while `apps/api/prisma/schema.prisma` declares the relation
 * (PRISMA-001 drift).
 *
 * Consequence of the missing constraint: a permission grant could reference
 * a nonexistent account (a dangling row). The API now refuses such grants
 * with the uniform 404 envelope, but only the DATABASE can make the
 * invariant real for every writer.
 *
 * This migration:
 *   1. removes the historical dangling grants (a grant on an account that
 *      does not exist can never be honoured — they are meaningless rows);
 *   2. adds the constraint `account_permissions_account_id_fkey` so the
 *      database enforces the reference from now on.
 *
 * Runs AS `ledgerline_owner` (DDL). Reversible: the `down` removes the
 * constraint (the deleted rows cannot be restored — they carried no
 * authority).
 */

function sql(statement) {
  return statement.trim();
}

async function up(pgm) {
  // 1. Purge grants that point at a nonexistent account.
  pgm.sql(sql(`
    DELETE FROM account_permissions p
     WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id)
  `));
  // 2. Enforce the reference for every future writer.
  pgm.sql(sql(`
    ALTER TABLE account_permissions
      ADD CONSTRAINT account_permissions_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES accounts(id)
  `));
}

async function down(pgm) {
  pgm.sql(sql(`
    ALTER TABLE account_permissions
      DROP CONSTRAINT IF EXISTS account_permissions_account_id_fkey
  `));
}

module.exports = { up, down };
