/**
 * Prisma client accessor (PHASE-04 P4.3+).
 *
 * BOUNDARY (normative, ADR-005 §"Data-access transaction strategy"):
 * - Routine typed CRUD only (users, sessions, grants administration, audit
 *   reads, statement pagination — Phase 5+).
 * - NEVER imported by any money-path module (domain/application use-case
 *   files owning financial operations); guarded by TX-BOUNDARY-001.
 * - Connects with the SAME runtime role as raw pg (DATABASE_URL).
 * - Each Prisma call owns exactly its own transaction; money-path flows never
 *   open a Prisma transaction.
 */

import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

let client: PrismaClient | undefined;

export type { PrismaClient };

export function prismaClient(): PrismaClient {
  if (!client) {
    // Lazy require: the generated client lives in src/generated/prisma.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PrismaClientCtor } = require("../generated/prisma/client") as {
      PrismaClient: new (options: {
        datasources?: { db: { url: string } };
      }) => PrismaClient;
    };
    client = new PrismaClientCtor({ datasources: { db: { url: config().DATABASE_URL } } });
  }
  return client;
}
