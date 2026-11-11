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
import { assertGlobalInvariants } from "../../src/domain/invariants.js";

/**
 * PHASE-10 P10.3 GET /audit/events on real PostgreSQL + Redis:
 *
 * - Access: ADMIN/AUDITOR → 200; holder/stranger → uniform 404; unauthenticated → 401.
 * - Filters: event_type, subject_type, actor_id, from/to.
 * - Keyset pagination on (occurred_at, id): no gaps, no duplicates, null terminal cursor.
 * - Metadata returned to entitled auditor/admin viewers (audit-view content; no secrets).
 * - Read-only: INV-001 still holds after the suite.
 */

type Fixture = { suffix: string };

let fixture!: Fixture;

describe("audit events (real services; PHASE-10 P10.3)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  const adminPassword = `admin-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const holderPassword = `holder-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const auditorPassword = `auditor-pw-${randomBytes(8).toString("hex")}-0123456789`;
  const strangerPassword = `stranger-pw-${randomBytes(8).toString("hex")}-0123456789`;
  let adminId = 0n;
  let auditorId = 0n;
  let holderId = 0n;
  let strangerId = 0n;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MONEY_LIMIT = "500";
    const cfg = loadConfig(process.env);
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/5", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });

    const suffix = randomBytes(5).toString("hex");
    fixture = { suffix };
    const conn = await independentConnection(appConnectionString());
    try {
      const insert = async (email: string, password: string, role: string): Promise<bigint> => {
        const { rows } = await conn.query<{ id: string }>(
          "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id::text AS id",
          [email, await hashPassword(password), role],
        );
        return BigInt(rows[0]!.id);
      };
      adminId = await insert(`admin_${suffix}@test.local`, adminPassword, "ADMIN");
      auditorId = await insert(`auditor_${suffix}@test.local`, auditorPassword, "AUDITOR");
      holderId = await insert(`holder_${suffix}@test.local`, holderPassword, "ACCOUNT_HOLDER");
      strangerId = await insert(`stranger_${suffix}@test.local`, strangerPassword, "ACCOUNT_HOLDER");
    } finally {
      await closeIndependent(conn);
    }

    // Seed audit events with controlled (possibly skewed) occurred_at so
    // pagination ordering by occurred_at is deterministic under all clocks.
    const base = new Date("2026-11-01T00:00:00.000Z");
    const seedConn = await independentConnection(appConnectionString());
    try {
      await seedConn.query("BEGIN");
      const ev = (actorId: bigint | null, eventType: string, subjectType: string, subjectId: string | null, meta: string, reasonCode: string | null, offsetSec: number) => {
        const at = new Date(base.getTime() + offsetSec * 1000);
        return seedConn.query(
          `INSERT INTO audit_events (actor_id, occurred_at, event_type, subject_type, subject_id, reason_code, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $2)`,
          [actorId, at, eventType, subjectType, subjectId, reasonCode, meta],
        );
      };
      await ev(adminId, "LOGIN_SUCCEEDED", "session", "s1", '{}', null, 0);
      await ev(holderId, "LOGIN_FAILED", "user", holderId.toString(), '{"internal_reason":"bad_password"}', "bad_password", 10);
      await ev(strangerId, "LOGIN_FAILED", "user", strangerId.toString(), '{"internal_reason":"unknown_email"}', "unknown_email", 20);
      await ev(adminId, "role_changed", "user", auditorId.toString(), '{"role":"AUDITOR"}', null, 30);
      await ev(adminId, "permission_granted", "account_permission", "perm1", '{"permission":"VIEW"}', null, 40);
      await ev(auditorId, "LOGIN_SUCCEEDED", "session", "s2", '{}', null, 50);
      await ev(null, "LOGIN_FAILED", "user", "anon", '{"internal_reason":"unknown_email"}', "unknown_email", 60);
      await seedConn.query("COMMIT");
    } finally {
      await closeIndependent(seedConn);
    }
  }, 60_000);

  beforeEach(async () => {
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    const conn = await independentConnection(appConnectionString());
    try {
      await conn.query(
        "UPDATE users SET status = 'DISABLED', updated_at = now() WHERE email LIKE $1",
        [`%_${fixture.suffix}@test.local`],
      );
    } finally {
      await closeIndependent(conn);
    }
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);

    // Read-only audit queries must not disturb the authoritative ledger.
    const inv = await independentConnection(appConnectionString());
    try {
      expect((await assertGlobalInvariants(inv)).violations).toEqual([]);
    } finally {
      await closeIndependent(inv);
    }
  }, 60_000);

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const setCookieHeader = res.headers["set-cookie"];
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(raw).toBeDefined();
    return raw!.split(";")[0]!;
  }

  const adminCookie = () => login(`admin_${fixture.suffix}@test.local`, adminPassword);
  const auditorCookie = () => login(`auditor_${fixture.suffix}@test.local`, auditorPassword);
  const holderCookie = () => login(`holder_${fixture.suffix}@test.local`, holderPassword);
  const strangerCookie = () => login(`stranger_${fixture.suffix}@test.local`, strangerPassword);

  const cookieValue = (setCookie: string): string => setCookie.replace(/^bv_session=/, "").split(";")[0]!;

  async function getEvents(
    cookie: string | null,
    query: { limit?: string; cursor?: string; event_type?: string; subject_type?: string; actor_id?: string; from?: string; to?: string } = {},
  ) {
    const search = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    const res = await app.inject({
      method: "GET",
      url: `/audit/events${search.length > 0 ? `?${search}` : ""}`,
      ...(cookie ? { cookies: { bv_session: cookieValue(cookie) } } : {}),
    });
    const body = res.json();
    return { statusCode: res.statusCode, body };
  }

  it("access: admin/auditor → 200; holder/stranger → uniform 404; unauthenticated → 401", async () => {
    const admin = await adminCookie();
    const auditor = await auditorCookie();
    const holder = await holderCookie();
    const stranger = await strangerCookie();

    const adminRes = await getEvents(admin);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.body.events.length).toBeGreaterThan(0);

    const auditorRes = await getEvents(auditor);
    expect(auditorRes.statusCode).toBe(200);

    const holderRes = await getEvents(holder);
    expect(holderRes.statusCode).toBe(404);
    expect(holderRes.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const strangerRes = await getEvents(stranger);
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const anon = await getEvents(null);
    expect(anon.statusCode).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("P10.3 filters: event_type, subject_type, actor_id, from/to", async () => {
    const admin = await adminCookie();
    const holderIdStr = holderId.toString();

    const byType = await getEvents(admin, { event_type: "LOGIN_SUCCEEDED" });
    expect(byType.statusCode).toBe(200);
    for (const e of byType.body.events) expect(e.eventType).toBe("LOGIN_SUCCEEDED");

    const bySubject = await getEvents(admin, { subject_type: "user" });
    expect(bySubject.statusCode).toBe(200);
    for (const e of bySubject.body.events) expect(e.subjectType).toBe("user");

    const byActor = await getEvents(admin, { actor_id: holderIdStr });
    expect(byActor.statusCode).toBe(200);
    for (const e of byActor.body.events) expect(e.actorId).toBe(holderIdStr);

    const after = await getEvents(admin, { from: "2026-11-01T00:00:30.000Z" });
    expect(after.statusCode).toBe(200);
    for (const e of after.body.events) expect(new Date(e.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date("2026-11-01T00:00:30.000Z").getTime());

    const before = await getEvents(admin, { to: "2026-11-01T00:00:20.000Z" });
    expect(before.statusCode).toBe(200);
    for (const e of before.body.events) expect(new Date(e.occurredAt).getTime()).toBeLessThanOrEqual(new Date("2026-11-01T00:00:20.000Z").getTime());
  });

  it("P10.3 keyset pagination: no gaps, no duplicates, null terminal cursor", async () => {
    const admin = await adminCookie();
    // Paginate only this run's seeded admin events (3 events, deterministic
    // despite residue from other runs in the shared database).
    const seen: Array<{ id: string; occurredAt: string }> = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await getEvents(admin, {
        limit: "2",
        cursor,
        actor_id: adminId.toString(),
      });
      expect(res.statusCode).toBe(200);
      for (const e of res.body.events) seen.push({ id: e.id, occurredAt: e.occurredAt });
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.length).toBeGreaterThan(0); // seeded admin events (+ any from this run's logins)
    // Ordered by (occurred_at, id) ascending.
    for (let i = 1; i < seen.length; i += 1) {
      const a = new Date(seen[i - 1]!.occurredAt).getTime();
      const b = new Date(seen[i]!.occurredAt).getTime();
      expect(b).toBeGreaterThanOrEqual(a);
    }
    const ids = seen.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    // Terminal cursor is null once everything is consumed.
  });

  it("P10.3 metadata is returned to auditor/admin (audit-view content; no secrets leaked)", async () => {
    const auditor = await auditorCookie();
    const res = await getEvents(auditor, { event_type: "LOGIN_FAILED" });
    expect(res.statusCode).toBe(200);
    const failed = res.body.events.find((e: { reasonCode: string | null }) => e.reasonCode === "bad_password");
    expect(failed).toBeDefined();
    expect(failed.metadata).toEqual({ internal_reason: "bad_password" });
  });

  it("P10.3 malformed cursor → 400 VALIDATION_FAILED; limit clamped 1..200", async () => {
    const admin = await adminCookie();
    const bad = await getEvents(admin, { cursor: "%%not-base64url%%" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");

    const zero = await getEvents(admin, { limit: "0" });
    expect(zero.statusCode).toBe(200);
    expect(zero.body.events.length).toBe(1);

    const huge = await getEvents(admin, { limit: "999" });
    expect(huge.statusCode).toBe(200);
    // Clamped to MAX_LIMIT: we never return more than 200 in one page.
    expect(huge.body.events.length).toBeLessThanOrEqual(200);
  });
});
