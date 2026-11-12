import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import { appConnectionString, envOrThrow, independentConnection, closeIndependent } from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * PHASE-05 P5.7 — admin-only user & permission management (AUTHZ_MATRIX §B),
 * on real PostgreSQL:
 *
 * - ADMIN creates users with any role; ACCOUNT_HOLDER/AUDITOR are refused
 *   with the uniform 404 envelope (no authorization oracle — REFUSAL_CODES §3).
 * - Role change revokes the target's sessions in the same transaction and is
 *   blocked by the last-admin guard (ADMIN-001: `admin_control` serialises
 *   count-reducing operations; at least one active administrator always
 *   remains).
 * - AUTH-004: an administrator may never grant a permission to themself.
 * - Every grant/revoke is an audit event (PERMISSION_GRANTED /
 *   PERMISSION_REVOKED / ROLE_CHANGED / USER_CREATED).
 */

type Seed = {
  adminEmail: string;
  adminId: string;
  holderEmail: string;
  holderId: string;
  teardown: () => Promise<void>;
};

/**
 * Disable every active administrator except those in `keepEmails` and return a
 * restore function. The last-admin guard only means something when exactly one
 * administrator is active, so the test controls that precondition instead of
 * assuming a pristine database.
 */
async function parkOtherAdmins(keepEmails: string[] = []): Promise<() => Promise<void>> {
  const conn = await independentConnection(appConnectionString());
  let ids: string[] = [];
  try {
    const { rows } = await conn.query<{ id: string }>(
      `SELECT id::text AS id FROM users
        WHERE role = 'ADMIN' AND status = 'ACTIVE' AND NOT (email = ANY($1::text[]))`,
      [keepEmails],
    );
    ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await conn.query(`UPDATE users SET status = 'DISABLED' WHERE id = ANY($1::bigint[])`, [ids]);
    }
  } finally {
    await closeIndependent(conn);
  }
  return async () => {
    if (ids.length === 0) return;
    const restore = await independentConnection(appConnectionString());
    try {
      await restore.query(`UPDATE users SET status = 'ACTIVE' WHERE id = ANY($1::bigint[])`, [ids]);
    } finally {
      await closeIndependent(restore);
    }
  };
}

async function insertUser(
  conn: Awaited<ReturnType<typeof independentConnection>>,
  email: string,
  passwordHash: string,
  role: string,
  status: string,
): Promise<string> {  const { rows } = await conn.query(
    "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, $4) RETURNING id",
    [email, passwordHash, role, status],
  );
  return String(rows[0].id);
}

let seedSuffix: string;

describe("admin user & permission management (real services; AUTHZ_MATRIX §B)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  let seed!: Seed;
  const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;

  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/3", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const conn = await independentConnection(appConnectionString());
    const suffix = randomBytes(5).toString("hex");
    const adminHash = await hashPassword(adminPassword);
    const holderHash = await hashPassword(holderPassword);
    const adminId = await insertUser(conn, `admin_${suffix}@test.local`, adminHash, "ADMIN", "ACTIVE");
    const holderId = await insertUser(conn, `holder_${suffix}@test.local`, holderHash, "ACCOUNT_HOLDER", "ACTIVE");
    await closeIndependent(conn);
    seedSuffix = suffix;
    seed = {
      adminEmail: `admin_${suffix}@test.local`,
      adminId,
      holderEmail: `holder_${suffix}@test.local`,
      holderId,
      teardown: async () => {
        // no-op: marker rows are unique per run; nothing shared to clean.
      },
    };
  }, 40_000);

  beforeEach(async () => {
    // Each test owns a fresh limiter bucket (adminCookie logs in via /login).
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    // Disable (never delete — users are append-only lifecycle rows) the fixture
    // users so a later bootstrap run sees no active administrator.
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1 OR email LIKE $2",
        [`admin_${seedSuffix}%`, `holder_${seedSuffix}%`],
      );
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 40_000);

  const asAdmin = (email = seed.adminEmail, password = adminPassword) =>
    app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });

  const sessionCookieValue = (setCookie: string[]): string => {
    const token = /bv_session=([^;]+)/.exec(setCookie[0] ?? "")?.[1];
    if (!token) throw new Error("login must set a session cookie");
    return `bv_session=${token}`;
  };

  const adminCookie = async (): Promise<string> => {
    const res = await asAdmin();
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    if (!setCookie) throw new Error("login must set a session cookie");
    return sessionCookieValue(Array.isArray(setCookie) ? setCookie : [setCookie]);
  };

  it("ADMIN creates a user with any role; argon2id at rest; USER_CREATED audit event", async () => {
    const cookie = await adminCookie();
    const email = `newuser_${randomBytes(4).toString("hex")}@test.local`;
    const res = await app.inject({
      method: "POST",
      url: "/users",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { email, password: `newuser-pw-${randomBytes(8).toString("hex")}-0123456789`, role: "AUDITOR" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("AUDITOR");

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT role, status, password_hash FROM users WHERE email = $1", [email]);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("AUDITOR");
      expect(rows[0].status).toBe("ACTIVE");
      expect(rows[0].password_hash.startsWith("$argon2id$")).toBe(true);
    } finally {
      await closeIndependent(conn);
    }

    const events = await prismaClient().auditEvent.findMany({
      where: { eventType: "USER_CREATED", subjectType: "user" },
    });
    expect(
      events.some(
        (e: { subjectId: string | null; metadata: unknown }) =>
          !!e.subjectId && !!e.metadata && (e.metadata as { role?: string }).role === "AUDITOR",
      ),
    ).toBe(true);
  });

  it("non-ADMIN actors get the uniform 404 envelope (no authorization oracle)", async () => {
    const holderCookie = await (async () => {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        headers: { "content-type": "application/json" },
        payload: { email: seed.holderEmail, password: holderPassword },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers["set-cookie"];
      if (!setCookie) throw new Error("login must set a session cookie");
      return sessionCookieValue(Array.isArray(setCookie) ? setCookie : [setCookie]);
    })();

    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const url = method === "POST" ? "/users" : method === "PATCH" ? `/users/${seed.adminId}/role` : "/account-permissions";
      const res = await app.inject({
        method,
        url,
        headers: { "content-type": "application/json", cookie: holderCookie },
        payload: method === "DELETE" ? {} : { email: "x@y.local", password: "p", role: "ACCOUNT_HOLDER" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("ADMIN role change revokes the target's sessions in the same transaction and is audited", async () => {
    const cookie = await adminCookie();
    // Seed an extra session for the holder (stolen-session scenario).
    const conn = await independentConnection(appConnectionString());
    const { randomBytes: rb, createHash } = await import("node:crypto");
    const token = rb(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    await conn.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [seed.holderId, tokenHash],
    );
    await closeIndependent(conn);

    const res = await app.inject({
      method: "PATCH",
      url: `/users/${seed.holderId}/role`,
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { role: "AUDITOR" },
    });
    expect(res.statusCode).toBe(200);

    const sessions = await prismaClient().session.findMany({ where: { userId: BigInt(seed.holderId) } });
    for (const s of sessions) {
      expect(s.revokedAt).not.toBeNull();
    }
    const events = await prismaClient().auditEvent.findMany({
      where: { eventType: "role_changed", subjectId: seed.holderId },
    });
    expect(events).toHaveLength(1);
    expect((events[0]?.metadata as { role?: string } | undefined)?.role).toBe("AUDITOR");
  });

  it("last-admin guard: demoting the only active ADMIN is refused (ADMIN-001)", async () => {
    // "The only active ADMIN" must be TRUE for the guard to be exercised, so
    // every other administrator in this shared database (a deployment's admin,
    // another suite's leftover) is parked for the duration and restored
    // afterwards. Without this the test silently stops testing the guard
    // whenever the database already holds an administrator.
    const restoreAdmins = await parkOtherAdmins([seed.adminEmail]);
    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      const cookie = await adminCookie();
      res = await app.inject({
        method: "PATCH",
        url: `/users/${seed.adminId}/role`,
        headers: { "content-type": "application/json", cookie: cookie },
        payload: { role: "ACCOUNT_HOLDER" },
      });
    } finally {
      await restoreAdmins();
    }
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("LAST_ADMIN_PROTECTED");

    // At least one active administrator always remains.
    const count = await prismaClient().user.count({ where: { role: "ADMIN", status: "ACTIVE" } });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("AUTH-004: an administrator may not grant a permission to themself", async () => {
    const cookie = await adminCookie();
    const res = await app.inject({
      method: "POST",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: seed.adminId, accountId: "9000000000002", permission: "WITHDRAW" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SELF_GRANT_REFUSED");
  });

  it("grant + revoke are audit events; revocation of an unknown grant is a no-op", async () => {
    const cookie = await adminCookie();
    // A REAL account: a grant must target an existing account (a dangling
    // grant row is no longer creatable).
    const created = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: {
        accountNumber: `grant_${randomBytes(5).toString("hex")}`,
        label: "grant target",
        currencyCode: "INR",
        kind: "CUSTOMER",
      },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().account.id as string;

    const grant = await app.inject({
      method: "POST",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: seed.holderId, accountId, permission: "WITHDRAW" },
    });
    expect(grant.statusCode).toBe(201);

    const revoke = await app.inject({
      method: "DELETE",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: seed.holderId, accountId, permission: "WITHDRAW" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revoked).toBe(true);

    const events = await prismaClient().auditEvent.findMany({
      where: {
        eventType: { in: ["permission_granted", "permission_revoked"] },
        subjectId: accountId,
      },
    });
    expect(events.map((e: { eventType: string }) => e.eventType).sort()).toEqual(["permission_granted", "permission_revoked"]);

    // Revoking again is an honest no-op, still audited.
    const revoke2 = await app.inject({
      method: "DELETE",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: seed.holderId, accountId, permission: "WITHDRAW" },
    });
    expect(revoke2.statusCode).toBe(200);
    expect(revoke2.json().revoked).toBe(false);
  });

  it("a grant for a nonexistent user or account is a uniform 404 (never a 500, never a dangling grant)", async () => {
    const cookie = await adminCookie();
    const created = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: {
        accountNumber: `grant404_${randomBytes(5).toString("hex")}`,
        label: "grant 404 target",
        currencyCode: "INR",
        kind: "CUSTOMER",
      },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().account.id as string;

    // Nonexistent (but well-formed) user id → uniform 404. Before the fix
    // this hit the users foreign key and surfaced as a raw 500.
    const unknownUser = await app.inject({
      method: "POST",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: "999999999", accountId, permission: "VIEW" },
    });
    expect(unknownUser.statusCode).toBe(404);
    expect(unknownUser.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    // Nonexistent account id → uniform 404 (no dangling grant row).
    const unknownAccount = await app.inject({
      method: "POST",
      url: "/account-permissions",
      headers: { "content-type": "application/json", cookie: cookie },
      payload: { userId: seed.holderId, accountId: "999999998", permission: "VIEW" },
    });
    expect(unknownAccount.statusCode).toBe(404);
    expect(unknownAccount.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    // The refusals left no grant rows behind (no dangling grants).
    const dangling = await prismaClient().accountPermission.findMany({
      where: { OR: [{ userId: 999999999n }, { accountId: 999999998n }] },
    });
    expect(dangling).toHaveLength(0);
  });
});
