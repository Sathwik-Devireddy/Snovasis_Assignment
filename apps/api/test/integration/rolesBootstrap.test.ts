import { describe, it, expect, beforeAll } from "vitest";
import {
  bootstrapConnectionString,
  independentConnection,
  ownerConnectionString,
  appConnectionString,
  closeIndependent,
} from "../harness.js";

/**
 * PHASE-04 P4.3 verification — the two roles exist and the separation holds,
 * against REAL PostgreSQL (no mocks). LED-001/LED-002 deepen these probes
 * once the financial tables land (Phase 6).
 */
describe("migration 0001: role separation (real PostgreSQL; P4.3)", () => {
  let bootstrap: Awaited<ReturnType<typeof independentConnection>> | undefined;
  let app: Awaited<ReturnType<typeof independentConnection>> | undefined;

  beforeAll(async () => {
    bootstrap = await independentConnection(bootstrapConnectionString());
    app = await independentConnection(appConnectionString());
  });

  it("ledgerline_owner and ledgerline_app exist with exactly the intended attributes", async () => {
    if (!bootstrap) throw new Error("bootstrap connection missing");
    const { rows } = await bootstrap.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
       FROM pg_roles WHERE rolname IN ('ledgerline_owner','ledgerline_app') ORDER BY rolname`,
    );
    expect(rows).toHaveLength(2);

    const owner = rows.find((r) => r.rolname === "ledgerline_owner");
    expect(owner).toMatchObject({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolinherit: false,
      rolcanlogin: true,
    });
    const appRole = rows.find((r) => r.rolname === "ledgerline_app");
    expect(appRole).toMatchObject({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolinherit: false,
      rolcanlogin: true,
    });
  });

  it("the database is owned by ledgerline_owner (migrations/DDL role)", async () => {
    if (!bootstrap) throw new Error("bootstrap connection missing");
    const { rows } = await bootstrap.query(
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`,
    );
    expect(rows[0]?.owner).toBe("ledgerline_owner");
  });

  it("the runtime role cannot perform DDL (LED-002 behavioural probe)", async () => {
    if (!app) throw new Error("app connection missing");
    await expect(app.query("CREATE TABLE forbidden_ddl_probe (id int)")).rejects.toThrow();
  });

  it("the runtime role can run a plain query (connectivity under ledgerline_app)", async () => {
    if (!app) throw new Error("app connection missing");
    const { rows } = await app.query("SELECT current_user AS u");
    expect(rows[0]?.u).toBe("ledgerline_app");
  });

  it("the owner role login cannot CREATE ROLE (role-creation stays bootstrap-only)", async () => {
    if (!bootstrap) throw new Error("bootstrap connection missing");
    const owner = await independentConnection(ownerConnectionString());
    try {
      await expect(owner.query("CREATE ROLE escalation_probe_role")).rejects.toThrow();
    } finally {
      await closeIndependent(owner);
    }
  });
});
