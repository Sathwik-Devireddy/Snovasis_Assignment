import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import {
  appConnectionString,
  ownerConnectionString,
  envOrThrow,
  independentConnection,
  closeIndependent,
} from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";

/**
 * Audit ATOMICITY regression (master-stabilisation B3 / finding 4.2).
 *
 * For every state change that writes an audit event, the state change and the
 * audit row must COMMIT TOGETHER or ROLL BACK TOGETHER:
 *   - POST /register    (user + USER_REGISTERED, one Prisma tx)
 *   - POST /login       (session + LOGIN_SUCCEEDED, one Prisma tx)
 *   - POST /logout      (revocation + SESSION_REVOKED, one Prisma tx)
 *   - POST /users       (user + USER_CREATED, one Prisma tx)
 *   - DELETE /account-permissions (revocation + permission_revoked, one tx)
 *
 * Failure injection: an owner-role BEFORE INSERT trigger on audit_events
 * raises ONLY when the inserted row references the marker entity armed in the
 * b3_audit_poison singleton table (created/dropped by this file). Rows from
 * every other test file or scenario never match the marker and are unaffected.
 * The route must then fail with the mapped infrastructure error AND the state
 * change must be absent (no partial user/session/revocation).
 */

const MARKER_PREFIX = "atomic_poison_";

const POISON_SETUP_SQL = `
CREATE TABLE IF NOT EXISTS b3_audit_poison (
  id integer PRIMARY KEY,
  marker_email text
);
INSERT INTO b3_audit_poison (id, marker_email) VALUES (1, NULL)
  ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION b3_poison_audit_fn() RETURNS trigger AS $fn$
DECLARE
  v_marker_email text;
  v_marker_id bigint;
BEGIN
  SELECT marker_email INTO v_marker_email FROM b3_audit_poison WHERE id = 1;
  IF v_marker_email IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_marker_id FROM users WHERE email = v_marker_email;
  IF v_marker_id IS NULL THEN RETURN NEW; END IF;
  IF (NEW.event_type = 'USER_REGISTERED' AND NEW.actor_id = v_marker_id)
     OR (NEW.event_type = 'USER_CREATED' AND NEW.subject_type = 'user'
         AND NEW.subject_id = v_marker_id::text)
     OR (NEW.event_type IN ('LOGIN_SUCCEEDED', 'SESSION_REVOKED') AND EXISTS (
           SELECT 1 FROM sessions s
            WHERE s.id::text = NEW.subject_id AND s.user_id = v_marker_id))
     OR (NEW.event_type = 'permission_revoked'
         AND NEW.metadata->>'userId' = v_marker_id::text)
  THEN
    RAISE EXCEPTION 'injected audit failure (B3 atomicity test)';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS b3_poison_audit_trig ON audit_events;
CREATE TRIGGER b3_poison_audit_trig
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION b3_poison_audit_fn();
`;

const POISON_TEARDOWN_SQL = `
DROP TRIGGER IF EXISTS b3_poison_audit_trig ON audit_events;
DROP FUNCTION IF EXISTS b3_poison_audit_fn();
DROP TABLE IF EXISTS b3_audit_poison;
`;

let app: FastifyInstance;
let pgPool: Pool;
let redis: ReturnType<typeof createRedisClient>;
const adminEmails: string[] = [];
const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;

function markerEmail(kind: string): string {
  return `${MARKER_PREFIX}${kind}_${randomBytes(4).toString("hex")}@test.local`;
}

describe("audit atomicity: state change + audit row commit together (master-stabilisation B3)", () => {
  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/7", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    // Install the poison trigger (owner role — DDL is not an app-role right).
    const owner = await independentConnection(ownerConnectionString());
    try {
      await owner.query(POISON_SETUP_SQL);
    } finally {
      await closeIndependent(owner);
    }
  }, 60_000);

  afterAll(async () => {
    const owner = await independentConnection(ownerConnectionString());
    try {
      await owner.query(POISON_TEARDOWN_SQL);
      if (adminEmails.length > 0) {
        await owner.query("UPDATE users SET status = 'DISABLED' WHERE email = ANY($1)", [
          adminEmails,
        ]);
      }
    } finally {
      await closeIndependent(owner);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient()
      .$disconnect()
      .catch(() => undefined);
  }, 60_000);

  /** Arms (or disarms with null) the audit-failure marker for one scenario. */
  async function setPoison(marker: string | null): Promise<void> {
    const owner = await independentConnection(ownerConnectionString());
    try {
      await owner.query("UPDATE b3_audit_poison SET marker_email = $1 WHERE id = 1", [marker]);
    } finally {
      await closeIndependent(owner);
    }
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    return raw.split(";")[0]!.replace(/^bv_session=/, "");
  }

  async function userExists(email: string): Promise<boolean> {
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT 1 FROM users WHERE email = $1", [email]);
      return rows.length > 0;
    } finally {
      await closeIndependent(conn);
    }
  }

  it("register: audit failure rolls the user creation back (no partial user)", async () => {
    const email = markerEmail("reg");
    await setPoison(email);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/register",
        headers: { "content-type": "application/json" },
        payload: { email, password: "a-long-reasonable-password-1" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INFRA_FAILURE");
      expect(await userExists(email)).toBe(false);
    } finally {
      await setPoison(null);
    }
  });

  it("login: audit failure rolls the session creation back (no session row)", async () => {
    const email = markerEmail("login");
    // Create the ACTIVE marker user directly (this user is the test fixture).
    const conn = await independentConnection(appConnectionString());
    let userId = "";
    try {
      const { rows } = await conn.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE') RETURNING id::text AS id",
        [email, await hashPassword("a-long-reasonable-password-2")],
      );
      userId = rows[0]!.id;
    } finally {
      await closeIndependent(conn);
    }
    await setPoison(email);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        payload: { email, password: "a-long-reasonable-password-2" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INFRA_FAILURE");
      // No session survived the failed audit insert.
      const check = await independentConnection(appConnectionString());
      try {
        const { rows } = await check.query("SELECT 1 FROM sessions WHERE user_id = $1", [
          BigInt(userId),
        ]);
        expect(rows).toHaveLength(0);
      } finally {
        await closeIndependent(check);
      }
    } finally {
      await setPoison(null);
      const cleanup = await independentConnection(appConnectionString());
      try {
        await cleanup.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [BigInt(userId)]);
      } finally {
        await closeIndependent(cleanup);
      }
    }
  });

  it("logout: audit failure leaves the session ACTIVE (no false success); retry succeeds", async () => {
    const email = markerEmail("logout");
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
    const conn = await independentConnection(appConnectionString());
    let userId = "";
    try {
      const { rows } = await conn.query<{ id: string }>(
        `WITH u AS (
           INSERT INTO users (email, password_hash, role, status)
           VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE') RETURNING id::text AS id
         ), s AS (
           INSERT INTO sessions (user_id, token_hash, expires_at, user_agent_hash)
           SELECT u.id::bigint, $3, now() + interval '1 hour', 'test'
           FROM u RETURNING user_id::text AS id
         )
         SELECT id FROM s`,
        [email, await hashPassword("a-long-reasonable-password-3"), tokenHash],
      );
      userId = rows[0]!.id;
    } finally {
      await closeIndependent(conn);
    }

    await setPoison(email);
    try {
      const failed = await app.inject({
        method: "POST",
        url: "/logout",
        cookies: { bv_session: rawToken },
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe("INFRA_FAILURE");
      // Revocation did NOT happen — the server must not fake success.
      const check = await independentConnection(appConnectionString());
      try {
        const { rows } = await check.query(
          "SELECT revoked_at FROM sessions WHERE token_hash = $1",
          [tokenHash],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].revoked_at).toBeNull();
      } finally {
        await closeIndependent(check);
      }
    } finally {
      await setPoison(null);
    }

    // Disarmed retry: revocation + audit commit together → confirmed success.
    const retry = await app.inject({
      method: "POST",
      url: "/logout",
      cookies: { bv_session: rawToken },
    });
    expect(retry.statusCode).toBe(200);
    const check2 = await independentConnection(appConnectionString());
    try {
      const { rows } = await check2.query("SELECT revoked_at FROM sessions WHERE token_hash = $1", [
        tokenHash,
      ]);
      expect(rows[0].revoked_at).not.toBeNull();
    } finally {
      await closeIndependent(check2);
      // Deactivate the marker fixture user.
      const cleanup = await independentConnection(appConnectionString());
      try {
        await cleanup.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [BigInt(userId)]);
      } finally {
        await closeIndependent(cleanup);
      }
    }
  });

  it("admin POST /users: audit failure rolls the user creation back", async () => {
    const adminEmail = `atomic_admin_${randomBytes(4).toString("hex")}@test.local`;
    adminEmails.push(adminEmail);
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE')",
        [adminEmail, await hashPassword(adminPassword)],
      );
    } finally {
      await closeIndependent(conn);
    }
    const admin = await login(adminEmail, adminPassword);

    const email = markerEmail("admincreate");
    await setPoison(email);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        cookies: { bv_session: admin },
        headers: { "content-type": "application/json" },
        payload: { email, password: "a-long-reasonable-password-4", role: "AUDITOR" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INFRA_FAILURE");
      expect(await userExists(email)).toBe(false);
    } finally {
      await setPoison(null);
    }

    // Success path (poison disarmed): user + exactly ONE audit event, and the
    // audit metadata carries no credential material.
    const res = await app.inject({
      method: "POST",
      url: "/users",
      cookies: { bv_session: admin },
      headers: { "content-type": "application/json" },
      payload: { email, password: "a-long-reasonable-password-4", role: "AUDITOR" },
    });
    expect(res.statusCode).toBe(201);
    // Deactivate the API-created target user in teardown.
    adminEmails.push(email);
    const createdId = res.json().user.id as string;
    const events = await prismaClient().auditEvent.findMany({
      where: { eventType: "USER_CREATED", subjectId: createdId },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("a-long-reasonable-password-4");
  });

  it("admin DELETE /account-permissions: audit failure leaves the grant ACTIVE", async () => {
    const adminEmail = `atomic_admin2_${randomBytes(4).toString("hex")}@test.local`;
    adminEmails.push(adminEmail);
    const conn = await independentConnection(appConnectionString());
    let markerUserId = "";
    let adminId = "";
    try {
      await conn.query("BEGIN");
      const { rows: adminRows } = await conn.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE') RETURNING id::text AS id",
        [adminEmail, await hashPassword(adminPassword)],
      );
      adminId = adminRows[0]!.id;
      const markerEmailValue = markerEmail("perm");
      adminEmails.push(markerEmailValue);
      const { rows: markerRows } = await conn.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE') RETURNING id::text AS id",
        [markerEmailValue, await hashPassword("a-long-reasonable-password-5")],
      );
      markerUserId = markerRows[0]!.id;
      // Seed an ACTIVE grant the admin will revoke.
      await conn.query(
        `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
         VALUES ($1, 1, 'VIEW', $2)`,
        [BigInt(markerUserId), BigInt(adminId)],
      );
      await conn.query("COMMIT");
    } finally {
      await closeIndependent(conn);
    }
    const admin = await login(adminEmail, adminPassword);

    // The poison trigger matches permission_revoked rows whose metadata
    // userId equals the marker user's id — arm the marker user's exact email.
    const emailRow = await independentConnection(appConnectionString());
    let exactEmail = "";
    try {
      const { rows } = await emailRow.query<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [BigInt(markerUserId)],
      );
      exactEmail = rows[0]!.email;
    } finally {
      await closeIndependent(emailRow);
    }
    await setPoison(exactEmail);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/account-permissions",
        cookies: { bv_session: admin },
        headers: { "content-type": "application/json" },
        payload: { userId: markerUserId, accountId: "1", permission: "VIEW" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INFRA_FAILURE");
      // The revocation did NOT commit.
      const check = await independentConnection(appConnectionString());
      try {
        const { rows } = await check.query(
          "SELECT revoked_at FROM account_permissions WHERE user_id = $1 AND account_id = 1 AND permission = 'VIEW'",
          [BigInt(markerUserId)],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].revoked_at).toBeNull();
      } finally {
        await closeIndependent(check);
      }
    } finally {
      await setPoison(null);
    }
  });
});
