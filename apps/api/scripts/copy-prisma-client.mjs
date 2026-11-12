#!/usr/bin/env node
/**
 * Copy the generated Prisma client into `dist/` (PRISMA-001).
 *
 * The compiled runtime (`dist/infrastructure/prisma.js`) lazily requires the
 * generated client with the relative path `../generated/prisma/client`. The
 * client itself is GENERATED JavaScript (not TypeScript), so `tsc` does not
 * emit it — without this copy step the production build cannot start:
 *   Error: Cannot find module '../generated/prisma/client'
 *
 * The query engine binary travels with the client, so the deploy target must
 * run `prisma generate` for its own platform (or ship the copied client).
 */

import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const source = path.join(apiRoot, "src", "generated", "prisma");
const target = path.join(apiRoot, "dist", "generated", "prisma");

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  console.error(
    `[copy-prisma-client] generated client missing at ${source} — run "prisma generate" first (npm run generate).`,
  );
  process.exit(1);
}

await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(
  `[copy-prisma-client] copied generated Prisma client → ${path.relative(apiRoot, target)}`,
);
