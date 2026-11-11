import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { appConnectionString, independentConnection, closeIndependent } from "../harness.js";
import { authorizeInTransaction, readGrantsForShare } from "../../src/domain/accountAuthority.js";

/**
 * PHASE-05 P5.7b + P5.13 — in-transaction grant authority, on REAL
 * PostgreSQL: `authorizeInTransaction` executes the raw-pg grant read
 * FOR SHARE inside its own transaction and refuses non-granted actors
 * (deny-by-default). Revocation conflicts are proven at the row-lock level:
 * a concurrent `FOR UPDATE` revocation of the SAME row must WAit for the
 * grant read's FOR SHARE to release (lock_timeout proves the conflict —
 * ADR-007/T-041 groundwork for the Phase 6/7 revocationRace tests).
 */

const accountA = 424_242_001; // arbitrary account ids — accounts table arrives Phase 6 (FK stub)
const accountB = 424_242_002;

let conn!: PoolClient;
let holderId!: string;
let otherHolderId!: string;

async function seed(): Promise<void> {
  conn = await independentConnection(appConnectionString());
  const suffix = randomBytes(5).toString("hex");
  const { hash } = await import("argon2");
  const encoded = await hash(`grant-fixture-pw-${suffix}-0123456789`, { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const { rows } = await conn.query(
    `INSERT INTO users (email, password_hash, role, status) VALUES
       ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE'),
       ($3, $2, 'ACCOUNT_HOLDER', 'ACTIVE')
     RETURNING id, email`,
    [`grantauth_${suffix}@test.local`, encoded, `grantauth_other_${suffix}@test.local`],
  );
  holderId = String(rows[0].id);
  otherHolderId = String(rows.find((r) => r.email.startsWith("grantauth_other_"))!.id);
}

describe("authorizeInTransaction (real PostgreSQL; P5.7b)", () => {
  beforeAll(seed, 40_000);

  afterAll(async () => {
    await closeIndependent(conn);
  });

  const actor = () => ({ id: "1", role: "ACCOUNT_HOLDER" as const, status: "ACTIVE" as const });

  it("an allowed action reads the grant FOR SHARE in-transaction and passes (deny-by-default holds elsewhere)", async () => {
    await conn.query(
      `INSERT INTO account_permissions (user_id, account_id, permission, granted_by) VALUES ($1, $2, 'TRANSFER', $1)`,
      [holderId, accountA],
    );
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: holderId,
        actor: actor(),
        action: "TRANSFER",
        accounts: [{ id: accountA, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(true);
      expect(decision.grants.get(String(accountA))).toBe("TRANSFER");
      await conn.query("COMMIT");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("a missing grant is REFUSED (POLICY_DENIED) — deny by default", async () => {
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: otherHolderId, // same active holder role, but NO grant
        actor: actor(),
        action: "WITHDRAW",
        accounts: [{ id: accountA, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe("POLICY_DENIED");
      expect(decision.grants.size).toBe(0);
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("an OTHER user's grant is never honoured (grant rows are user_id-scoped)", async () => {
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: otherHolderId,
        actor: actor(),
        action: "TRANSFER",
        accounts: [{ id: accountA, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(false);
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("a wrong permission kind is refused (WITHDRAW grant does not satisfy TRANSFER)", async () => {
    await conn.query(
      `INSERT INTO account_permissions (user_id, account_id, permission, granted_by) VALUES ($1, $2, 'WITHDRAW', $1)`,
      [otherHolderId, accountB],
    );
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: otherHolderId,
        actor: actor(),
        action: "TRANSFER",
        accounts: [{ id: accountB, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(false);
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("a non-ACTIVE actor is refused (ACTOR_INACTIVE for the disabled/revoked-authority envelope)", async () => {
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: holderId,
        actor: { id: "2", role: "ACCOUNT_HOLDER", status: "DISABLED" },
        action: "TRANSFER",
        accounts: [{ id: accountA, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe("ACTOR_INACTIVE");
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("the FOR SHARE read CONFLICTS with a concurrent FOR UPDATE revocation (ADR-007 serialisation, lock_timeout evidence)", async () => {
    // Holder's grant row exists from the first test. One connection holds
    // FOR SHARE inside an open transaction; a second connection must be
    // REFUSED to revoke (UPDATE ... revoked_at) within the tolerance window.
    await conn.query("BEGIN");
    try {
      const grants = await readGrantsForShare(conn, holderId, [accountA]);
      expect(grants.size).toBe(1);

      const rival = await independentConnection(appConnectionString());
      try {
        await rival.query("SET lock_timeout = '500ms'");
        await expect(
          rival.query(
            `UPDATE account_permissions SET revoked_at = now() WHERE user_id = $1 AND account_id = $2`,
            [holderId, accountA],
          ),
        ).rejects.toThrow(); // waits on the FOR SHARE, then lock timeout wipes it out
      } finally {
        await rival.query("ROLLBACK").catch(() => undefined);
        await closeIndependent(rival);
      }
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  it("revoked grants are invisible: the read ignores rows with revoked_at set", async () => {
    await conn.query(
      `UPDATE account_permissions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [holderId],
    );
    await conn.query("BEGIN");
    try {
      const decision = await authorizeInTransaction(conn, {
        actorId: holderId,
        actor: actor(),
        action: "TRANSFER",
        accounts: [{ id: accountA, kind: "CUSTOMER", status: "ACTIVE" }],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.denialReason).toBe("POLICY_DENIED");
      await conn.query("ROLLBACK");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
});
