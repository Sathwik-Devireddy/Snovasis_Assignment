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
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * PHASE-05 P5.10/P5.13 — POST /register (REG-001/REG-002).
 * Real PostgreSQL + Redis: proves the registration authority floor —
 * ACCOUNT_HOLDER fixed server-side (role never accepted from the request),
 * no accounts/grants/money authority, duplicate-email uniformity, argon2id
 * at rest, and audit-event record.
 */

function freshEmail(): string {
  return `reg_${randomBytes(5).toString("hex")}@test.local`;
}

describe("POST /register (real services; REG-001/REG-002)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  const password = "a-long-reasonable-registration-password-1";

  beforeAll(() => {
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    // Dedicated Redis database so parallel test files never share limiter buckets.
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/2", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });
  });

  beforeEach(async () => {
    // Each test owns a fresh limiter bucket (limiter runs before handler logic).
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
  });

  it("creates an ACCOUNT_HOLDER user with argon2id at rest and an audit event (REG-001)", async () => {
    const email = freshEmail();
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe("ACCOUNT_HOLDER");
    expect(body.user.email).toBe(email);

    // Verify AT REST through the runtime role's own eyes (no owner privileges).
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT role, status, password_hash FROM users WHERE email = $1", [email]);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("ACCOUNT_HOLDER");
      expect(rows[0].status).toBe("ACTIVE");
      expect(rows[0].password_hash.startsWith("$argon2id$")).toBe(true);
      expect(rows[0].password_hash).not.toContain(password); // plaintext never at rest
    } finally {
      await closeIndependent(conn);
    }

    const events = await prismaClient().auditEvent.findMany({
      where: { eventType: "USER_REGISTERED", subjectId: body.user.id },
    });
    expect(events).toHaveLength(1);
  });

  it("role escalation via the request body is refused — the side effect is only ever a holder (Gate 5)", async () => {
    const email = freshEmail();
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      // .strict() body schema: any injected role/user fields make the body invalid.
      payload: { email, password, role: "ADMIN", status: "ACTIVE", user_id: "9999" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    // Nothing was created
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT 1 FROM users WHERE email = $1", [email]);
      expect(rows).toHaveLength(0);
    } finally {
      await closeIndependent(conn);
    }
  });

  it("duplicate email returns the SAME uniform envelope as any invalid registration (no enumeration — REG-002)", async () => {
    const email = freshEmail();
    const first = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    const weak = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email: freshEmail(), password: "short" },
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email: "not-an-email", password },
    });
    for (const res of [dup, weak, malformed]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({ code: "VALIDATION_FAILED", message: "Registration failed." });
    }
    // Byte-identical envelopes for duplicate + weak + malformed
    expect(new Set([dup.body, weak.body, malformed.body]).size).toBe(1);
  });

  it("weak password / malformed bodies create nothing", async () => {
    const suffix = randomBytes(4).toString("hex");
    const probeEmail = `reg_malformed_${suffix}@test.local`;
    const before = await prismaClient().user.count({ where: { email: probeEmail } });
    expect(before).toBe(0);
    for (const payload of [
      { email: probeEmail, password: "short" },
      { email: probeEmail },
      { email: probeEmail, password: "x".repeat(202) },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/register",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await prismaClient().user.count({ where: { email: probeEmail } })).toBe(before);
  });

  it("a cross-origin Origin header on a mutating registration is refused (P5.6)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json", origin: "https://evil.example", host: "localhost:4000" },
      payload: { email: freshEmail(), password },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("a fresh registrant has NO money authority surface: no accounts, no grants reachable (REG-001 boundary)", async () => {
    const email = freshEmail();
    await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    // No account_permissions rows may reference the fresh user; the user has
    // zero accounts (accounts arrive in Phase 6 — the identity-only invariant).
    const conn = await independentConnection(appConnectionString());
    try {
      const { rows: grants } = await conn.query(
        `SELECT count(*)::int AS n FROM account_permissions p JOIN users u ON u.id = p.user_id WHERE u.email = $1`,
        [email],
      );
      expect(grants[0].n).toBe(0);
      const { rows: roleRows } = await conn.query("SELECT role FROM users WHERE email = $1", [email]);
      expect(roleRows[0].role).toBe("ACCOUNT_HOLDER"); // provable role floor
    } finally {
      await closeIndependent(conn);
    }
  });
});
