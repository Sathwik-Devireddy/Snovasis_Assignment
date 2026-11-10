import type { Pool, PoolConfig } from "pg";
import { config } from "../config.js";

/**
 * Raw-pg pool — THE money-path client and the infrastructure boundary for
 * every financial transaction (ADR-005 §"Data-access transaction strategy").
 * The DomainTransactionRunner (Phase 6+) will own all financial transactions
 * through this pool; Prisma never participates in them.
 */

export type PgPoolOptions = PoolConfig;

type PgModule = { Pool: new (options: PoolConfig) => Pool };

export function createPgPool(options: PgPoolOptions = makeDefaultPgOptions()): Pool {
  // Lazy require keeps pg loaded only when a concrete pool is needed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg") as PgModule;
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    // Fail fast on a stuck statement — kit requires lock_timeout/statement_timeout (T-035).
    statement_timeout: 10_000,
    lock_timeout: 5_000,
  });
}

export function makeDefaultPgOptions(): PgPoolOptions {
  return { connectionString: config().DATABASE_URL };
}
