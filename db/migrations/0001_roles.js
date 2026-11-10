"use strict";

/**
 * Migration 0001 — the two database roles (PHASE-04 P4.3; ADR-005 decision 1).
 *
 * Runs AS the bootstrap superuser (DATABASE_URL_BOOTSTRAP) — role creation
 * requires CREATEROLE-class privilege, which the owner role itself must never
 * hold. Every later migration runs AS `ledgerline_owner`.
 *
 * `ledgerline_owner`  — runs migrations only (schema DDL). Becomes owner of
 *                       the whole database, hence of the public schema.
 * `ledgerline_app`    — the runtime role for BOTH the raw-pg money path and
 *                       the Prisma routine path (ADR-005 §"Data-access
 *                       transaction strategy"). Inherits no privileges from
 *                       its creator (superusers must not leak grants).
 *
 * Passwords come from the environment (OWNER_ROLE_PASSWORD /
 * APP_ROLE_PASSWORD) — never committed (T-015).
 */

const roleNameOwner = "ledgerline_owner";
const roleNameApp = "ledgerline_app";

/** SQL literal for a password, single-quote-safe. */
function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Parse the database name out of a service URL (default: balancevault). */
function dbNameFrom(url) {
  try {
    const u = new URL(url);
    const name = u.pathname.replace(/^\//, "");
    return name.length > 0 ? name : "balancevault";
  } catch {
    return "balancevault";
  }
}

async function up(pgm) {
  const ownerPassword = process.env.OWNER_ROLE_PASSWORD;
  const appPassword = process.env.APP_ROLE_PASSWORD;
  if (!ownerPassword || !appPassword) {
    throw new Error(
      "OWNER_ROLE_PASSWORD / APP_ROLE_PASSWORD must be set in the environment for migration 0001 (bootstrap).",
    );
  }

  // Roles — guarded so a partially-bootstrapped local database converges.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(roleNameOwner)}) THEN
        CREATE ROLE ${roleNameOwner} LOGIN PASSWORD ${sqlString(ownerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(roleNameApp)}) THEN
        CREATE ROLE ${roleNameApp} LOGIN PASSWORD ${sqlString(appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);

  // The owner owns the database (=> schema `public` through pg_database_owner),
  // so later migrations (run as ledgerline_owner) can create/alter objects.
  pgm.sql(
    `ALTER DATABASE ${dbNameFrom(process.env.DATABASE_URL_OWNER ?? "")} OWNER TO ${roleNameOwner};`,
  );

  // node-pg-migrate bookkeeping table was created by the bootstrap connection;
  // later migration runs connect as the owner, so ownership transfers here.
  pgm.sql(`ALTER TABLE pgmigrations OWNER TO ${roleNameOwner};`);

  // Runtime role: connect + schema usage only. Table-level grants arrive with
  // each table's own migration (schema draft planned-grants block; Phase 5/6).
  pgm.sql(`
    GRANT CONNECT ON DATABASE ${dbNameFrom(process.env.DATABASE_URL_OWNER ?? "")} TO ${roleNameOwner}, ${roleNameApp};
    GRANT USAGE ON SCHEMA public TO ${roleNameApp};
  `);
}

async function down(pgm) {
  // Dev/CI teardown only. The bookkeeping table was transferred to
  // ledgerline_owner in `up`; give it back to the bootstrap role so the roles
  // drop cleanly. Bootstrap user/url comes from the environment.
  const bootstrapUser = userFrom(process.env.DATABASE_URL_BOOTSTRAP ?? "");
  if (bootstrapUser) {
    pgm.sql(`ALTER TABLE pgmigrations OWNER TO ${quoteIdent(bootstrapUser)};`);
    pgm.sql(
      `ALTER DATABASE ${dbNameFrom(process.env.DATABASE_URL_OWNER ?? "")} OWNER TO ${quoteIdent(bootstrapUser)};`,
    );
  }
  pgm.sql(`
    REVOKE ALL ON SCHEMA public FROM ${roleNameApp};
    REVOKE ALL ON SCHEMA public FROM ${roleNameOwner};
    REVOKE ALL ON DATABASE ${dbNameFrom(process.env.DATABASE_URL_OWNER ?? "")} FROM ${roleNameApp};
    REVOKE ALL ON DATABASE ${dbNameFrom(process.env.DATABASE_URL_OWNER ?? "")} FROM ${roleNameOwner};
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(roleNameApp)}) THEN
        DROP ROLE ${roleNameApp};
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlString(roleNameOwner)}) THEN
        DROP ROLE ${roleNameOwner};
      END IF;
    END
    $$;
  `);
}

function userFrom(url) {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return "";
  }
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

module.exports = { up, down };
