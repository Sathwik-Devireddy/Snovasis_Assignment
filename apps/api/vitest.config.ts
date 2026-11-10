import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load the repo .env before tests import config (local dev; CI passes real env
// and dotenv does not override existing values). No other source: the harness
// throws on missing vars instead of silently mocking PostgreSQL.
const file = fileURLToPath(import.meta.url);
const hereDir = path.dirname(file);
dotenv.config({ path: path.join(hereDir, "..", "..", ".env"), quiet: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    filesParallel: false, // concurrency tests need deterministic DB ordering
  },
});
