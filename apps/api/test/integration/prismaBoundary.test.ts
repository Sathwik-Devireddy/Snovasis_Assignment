import { describe, it, expect } from "vitest";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import {
  appConnectionString,
  bootstrapConnectionString,
  closeIndependent,
  createTestSchema,
  independentConnection,
} from "../harness.js";

/**
 * PHASE-04 P4.5 + P4.3+ — Prisma (routine path) and raw pg (money path)
 * connect to the SAME database under the SAME runtime role `ledgerline_app`
 * (ADR-005 §4). Deep schema-drift/money-boundary assertions arrive with the
 * financial tables (PRODROLE-001, PRISMA-001, TX-BOUNDARY-001 in Phase 5/6);
 * this Phase-4 slice pins the boundary facts that already exist.
 */
describe("prisma/raw-pg same-database boundary (P4.5+)", () => {
  let sharedDb: string | undefined;

  it("Prisma connects under ledgerline_app using DATABASE_URL", async () => {
    const row = (await prismaClient().$queryRaw<{ user: string; db: string }[]>`
      SELECT current_user AS user, current_database() AS db
    `)[0];
    expect(row?.user).toBe("ledgerline_app");
    sharedDb = row?.db;
    expect(sharedDb).toBeTruthy();
  });

  it("raw pg connects to the SAME database under the SAME role", async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT current_user AS u, current_database() AS db");
      expect(rows[0]?.u).toBe("ledgerline_app");
      expect(rows[0]?.db).toBe(sharedDb);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("a fresh per-file schema can be created and torn down (harness isolation works)", async () => {
    const admin = await independentConnection(bootstrapConnectionString());
    const { schemaName, teardown } = await createTestSchema(admin);
    try {
      const { rows } = await admin.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
        [schemaName],
      );
      expect(rows).toHaveLength(1);
      expect(schemaName.startsWith("test_")).toBe(true);
    } finally {
      await teardown();
      await closeIndependent(admin);
    }
  });

  it("an uncommitted raw-pg transaction is INVISIBLE to Prisma (separate pools — ADR-005 proof)", async () => {
    // ADR-005 §1 normative claim, demonstrated at runtime: a Prisma
    // transaction can never absorb pg-client statements, because they use
    // independent pooled connections. (Both clients connect under
    // ledgerline_app — the same role, never the same transaction.)
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query("BEGIN");
      await conn.query("CREATE TEMP TABLE boundary_probe (v int) ON COMMIT DROP");
      await conn.query("INSERT INTO boundary_probe VALUES (1)");
      // Prisma runs on ITS OWN connection: the temp table (session-local anyway)
      // is not visible there — separate-connection semantics asserted.
      await expect(
        prismaClient().$queryRaw`SELECT v FROM boundary_probe`,
      ).rejects.toThrow();
      const { rows } = await conn.query("SELECT v FROM boundary_probe");
      expect(rows[0]?.v).toBe(1);
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
      await closeIndependent(conn);
    }
  });

  it("Prisma under ledgerline_app cannot consume owner privileges (LED-002 analogue via Prisma)", async () => {
    await expect(
      prismaClient().$transaction([prismaClient().$executeRawUnsafe("CREATE TABLE prisma_ddl_probe (x int)")]),
    ).rejects.toThrow();
  });
});
