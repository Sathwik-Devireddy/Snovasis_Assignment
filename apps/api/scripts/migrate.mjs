/**
 * Migration runner (PHASE-04 P4.3) — Windows/CI-safe wrapper around the
 * programmatic node-pg-migrate `runner()`.
 *
 *   node apps/api/scripts/migrate.mjs               → migrate up as ledgerline_owner
 *   node apps/api/scripts/migrate.mjs --bootstrap   → migrate up as bootstrap superuser (role creation, 0001)
 *   ... --down  [--bootstrap]                       → migrate down
 *
 * node-pg-migrate is the ONLY migration authority (ADR-005 §5): Prisma's
 * migration engine is never invoked anywhere in this repository.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const hereDir = path.dirname(fileURLToPath(import.meta.url));
// apps/api/scripts → apps/api → apps → repo root (node-pg-migrate resolves `dir` from cwd).
const migrationsDirectory = path.join(hereDir, "..", "..", "..", "db", "migrations");

const argv = new Set(process.argv.slice(2));
const bootstrap = argv.has("--bootstrap");
const down = argv.has("--down");

const urlName = bootstrap ? "DATABASE_URL_BOOTSTRAP" : "DATABASE_URL_OWNER";
const url = process.env[urlName];
if (!url || url.length === 0) {
  console.error(
    `Missing ${urlName} in the environment (load the project .env, e.g. node --env-file). Failing fast.`,
  );
  process.exit(1);
}

// node-pg-migrate is ESM-only in v8 — dynamic import keeps this runner dual-safe.
const { runner } = await import("node-pg-migrate");

try {
  await runner({
    databaseUrl: url,
    // node-pg-migrate v8 API: `dir` (path resolved from cwd), default table pgmigrations.
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    migrationsSchema: "public",
    schema: "public",
    direction: down ? "down" : "up",
    count: Infinity,
    verbose: process.env.LOG_LEVEL === "debug",
  });
  console.log(`[${bootstrap ? "bootstrap" : "owner"}] migration run finished.`);
} catch (error) {
  console.error("Migration run FAILED:", error);
  process.exit(1);
}
