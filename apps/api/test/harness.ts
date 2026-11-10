/**
 * Real-PostgreSQL test harness (PHASE-04 P4.5).
 *
 * - ONE FRESH SCHEMA PER TEST FILE: `createTestSchema()` is called at the top
 *   of each integration/concurrency test file; the schema name is random and
 *   never reused. Money tables arrive in Phase 5/6 — the harness already
 *   guarantees isolation and role separation.
 * - INDEPENDENT CONNECTIONS: `independentConnection()` opens a brand-new pg
 *   client per call — concurrency tests use different actor connections as the
 *   kit mandates (CON-001/IDEM-003 style tests, Phase 7/8).
 * - ROLE SEPARATION: the function layer connects as the RUNTIME role
 *   (`DATABASE_URL`, ledgerline_app); schema DDL happens through the bootstrap
 *   superuser connection (DATABASE_URL_BOOTSTRAP) which never runs financial
 *   statements.
 * - Prisma smoke (P4.5+): `assertPrismaSmoke()` is a ROUTINE-path connectivity
 *   check only — never used where a financial operation runs.
 */

import dotenv from "dotenv";
import path from "node:path";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";

// Local dev convenience: load the repo .env once (CI provides real env vars;
// dotenv does not override existing values). Works whether the runner's cwd
// is apps/api (npm workspaces) or the repo root.
const hereDir = process.cwd();

function findRepoEnv(): string {
  const fromApi = path.join(hereDir, "..", "..", ".env");
  if (existsSync(fromApi)) return fromApi;
  return path.join(hereDir, ".env");
}
dotenv.config({ path: findRepoEnv(), quiet: true });

export function envOrThrow(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing ${name} for the real-PostgreSQL test harness. ` +
        `Provide it via the CI environment or the repo .env file. Failing fast, not mocking.`,
    );
  }
  return value;
}

/** Fresh schema for one test file: created, granted to the runtime role, and labelled. */
export async function createTestSchema(admin: PoolClient): Promise<{
  schemaName: string;
  teardown: () => Promise<void>;
}> {
  const schemaName = `test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO ledgerline_app`);
  const teardown = async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  };
  return { schemaName, teardown };
}

/**
 * A brand-new, independent connection (never cached/shared) — one per caller.
 * disconnection: NEVER call pool.end() through a monkeypatched release()
 * (pg Pool internals call client.release in their own flows — an override
 * deadlocks subsequent pools). Use `closeIndependent(client)` instead.
 */
export async function independentConnection(connectionString: string): Promise<PoolClient> {
  const pool = new Pool({
    connectionString,
    max: 1,
    // Fail fast with a REAL error instead of an opaque 30s test timeout.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  pool.on("error", (error: NodeJS.ErrnoException) =>
    console.error("[harness pool error]", error.code, error.message),
  );
  const client = await pool.connect();
  (client as PoolClient & { testPool: Pool }).testPool = pool;
  return client;
}

/** Ends the dedicated single-connection pool behind an independentConnection client. */
export async function closeIndependent(client: PoolClient): Promise<void> {
  client.release(); // the client MUST be returned to its pool before end()
  const pool = (client as PoolClient & { testPool?: Pool }).testPool;
  if (pool) {
    await pool.end();
  }
}

export const appConnectionString = (): string => envOrThrow("DATABASE_URL");
export const ownerConnectionString = (): string => envOrThrow("DATABASE_URL_OWNER");
export const bootstrapConnectionString = (): string => envOrThrow("DATABASE_URL_BOOTSTRAP");
