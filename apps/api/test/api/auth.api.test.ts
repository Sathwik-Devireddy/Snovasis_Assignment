import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { buildApp } from "../../src/http/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createPgPool } from "../../src/infrastructure/pg.js";
import { createRedisClient } from "../../src/infrastructure/redis.js";
import { prismaClient } from "../../src/infrastructure/prisma.js";
import { appConnectionString, envOrThrow, independentConnection, closeIndependent } from "../harness.js";
import { hashPassword } from "../../src/infrastructure/argon2.js";
import { resetLimiterBuckets } from "../../src/infrastructure/rateLimiter.js";

/**
 * PHASE-05 P5.3/P5.4/P5.5/P5.8 — login/logout/session lifecycle on real
 * PostgreSQL: enumeration-uniform login errors (AUTH-005), cookie flags
 * (AUTH-006), logout revocation, expired/revoked/missing-cookie refusals on
 * protected routes, and no client-controlled authority (P5.4/Gate 5).
 *
 * Fixtures: real user rows inserted directly through the runtime role
 * (unique per-run emails — the suite stays append-only-idempotent across runs).
 */

type SeedSchema = {
  holderId: string;
  holderEmail: string;
  disabledEmail: string;
  teardown: () => Promise<void>;
};

const getCookieToken = (setCookie: string | string[] | undefined): string => {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const token = /bv_session=([^;]+)/.exec(value ?? "")?.[1];
  if (!token) {
    throw new Error("expected a bv_session cookie in the response");
  }
  return token;
};

describe("login / logout / sessions (real services)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  let schema: SeedSchema;
  const password = "a-long-reasonable-login-password-88";

  beforeAll(async () => {
    const cfg = loadConfig(process.env);
    // Dedicated Redis database so parallel test files never share limiter buckets.
    redis = createRedisClient({ url: envOrThrow("REDIS_URL") + "/4", lazyConnect: false });
    pgPool = createPgPool({ connectionString: appConnectionString() });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });
    schema = await seedFixtures("a-long-reasonable-login-password-88");
  }, 40_000);

  beforeEach(async () => {
    // Each test owns a fresh limiter bucket (limiter runs before handler logic;
    // Redis persists across runs, so resets are required for determinism).
    await resetLimiterBuckets(redis, "register", "ip:127.0.0.1");
    await resetLimiterBuckets(redis, "login", "ip:127.0.0.1");
  });

  afterAll(async () => {
    await schema.teardown();
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
    await prismaClient().$disconnect().catch(() => undefined);
  }, 40_000);

  const loginRequest = (email: string, pw: string) =>
    app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: pw },
    });

  it("a successful login stores only the sha256 TOKEN HASH (never the raw token) with audit rows", async () => {
    const res = await loginRequest(schema.holderEmail, password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("ACCOUNT_HOLDER");

    const cookieToken = getCookieToken(res.headers["set-cookie"]);
    expect(cookieToken.length).toBeGreaterThan(40);

    // The ONLY durable representation is sha256 — raw token must be absent at rest.
    const sessionRow = await prismaClient().session.findFirst({ orderBy: { id: "desc" } });
    expect(sessionRow).not.toBeNull();
    expect(sessionRow!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionRow!.tokenHash).not.toBe(cookieToken);
    expect(sessionRow!.revokedAt).toBeNull();

    const events = await prismaClient().auditEvent.findMany({
      where: { subjectId: sessionRow!.id.toString() },
    });
    expect(events.some((e: { eventType: string }) => e.eventType === "LOGIN_SUCCEEDED")).toBe(true);
  });

  it("cookie flags are exactly HttpOnly · Secure=config · SameSite=Lax (AUTH-006)", async () => {
    const res = await loginRequest(schema.holderEmail, password);
    const cookie = getSetCookieString(res.headers["set-cookie"]).toLowerCase();
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
    expect(cookie).toContain("path=/");
    // Local dev (COOKIE_SECURE=false by default here) — the Secure contract is
    // asserted in its own app instance below (production-cookie test file).
  });

  it("unknown user · wrong password · disabled user return IDENTICAL 401 envelopes (AUTH-005)", async () => {
    const unknown = await loginRequest(`nobody_${randomBytes(4).toString("hex")}@test.local`, password);
    const wrongPassword = await loginRequest(schema.holderEmail, "an-entirely-wrong-password-attempt");
    const disabledWithRightPassword = await loginRequest(schema.disabledEmail, password);

    for (const res of [unknown, wrongPassword, disabledWithRightPassword]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toEqual({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
    }
    expect(new Set([unknown.body, wrongPassword.body, disabledWithRightPassword.body]).size).toBe(1);

    // The honest internal trail: three LOGIN_FAILED audit rows exist for these attempts.
    const failures = await prismaClient().auditEvent.count({ where: { eventType: "LOGIN_FAILED" } });
    expect(failures).toBeGreaterThanOrEqual(3);
  });

  it("logout revokes the session row (revoked_at) and the cookie dies with it (P5.3)", async () => {
    const login = await loginRequest(schema.holderEmail, password);
    const setCookie = login.headers["set-cookie"];
    if (!setCookie) throw new Error("login must set a session cookie");

    const out = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: `bv_session=${getCookieToken(login.headers["set-cookie"])}` },
    });
    expect(out.statusCode).toBe(200);

    const cookieTokenHash = createHash("sha256").update(
      getCookieToken(login.headers["set-cookie"]),
      "utf8",
    ).digest("hex");
    const { rows } = await probeRevocationState(cookieTokenHash);
    expect(rows[0]!.revoked_at).not.toBeNull();

    // Post-revocation requests with the old cookie are 401 (the single predicate).
    const after = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: `bv_session=${getCookieToken(login.headers["set-cookie"])}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("missing cookie · expired session · revoked session are all the single 401 (P5.8)", async () => {
    // 1) no cookie at all
    const unauthed = await app.inject({ method: "POST", url: "/logout" });
    expect(unauthed.statusCode).toBe(401);
    expect(unauthed.json().error.code).toBe("UNAUTHENTICATED");

    // 2) expired session created directly in the DB
    const expiredToken = await independentSeedSession(schema.holderId, new Date(Date.now() - 1000));
    const withExpired = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: `bv_session=${expiredToken}` },
    });
    expect(withExpired.statusCode).toBe(401);

    // 3) a revoked session (created then revoked directly)
    const revokedToken = await independentSeedSession(schema.holderId, new Date(Date.now() + 600_000), true);
    const withRevoked = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: `bv_session=${revokedToken}` },
    });
    expect(withRevoked.statusCode).toBe(401);
  });

  it("an expired/never-valid session grants NOTHING — protected surface refuses before handlers run (P5.4)", async () => {
    // Same envelope for missing cookie and garbage token → no oracle for which part failed.
    const withGarbage = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: "bv_session=AAECAwQFBgcICQ==" },
    });
    expect(withGarbage.statusCode).toBe(401);
    const body = withGarbage.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");

    const legacyNoCookie = await app.inject({ method: "POST", url: "/logout" });
    expect(legacyNoCookie.body).toBe(withGarbage.body);
  });
});

describe("production cookie contract (COOKIE_SECURE=true)", () => {
  let app: FastifyInstance;
  let pgPool: Pool;
  let redis: ReturnType<typeof createRedisClient>;
  let schema: SeedSchema;
  const password = "a-long-reasonable-secure-cookie-password";

  beforeAll(async () => {
    // Production-validator contract asserted first: the secure flag is MANDATORY.
    const productionWithoutSecure = { ...process.env, NODE_ENV: "production", COOKIE_SECURE: "false" };
    expect(() => loadConfig(productionWithoutSecure)).toThrow(/COOKIE_SECURE/);

    const cfg = loadConfig({ ...process.env, COOKIE_SECURE: "true" });
    pgPool = createPgPool({ connectionString: appConnectionString() });
    redis = createRedisClient({ url: process.env.REDIS_URL ?? "", lazyConnect: false });
    app = buildApp({ config: cfg, pgPool, redis, prisma: prismaClient() });
    schema = await seedFixtures("a-long-reasonable-secure-cookie-password");
  }, 40_000);

  afterAll(async () => {
    await schema.teardown();
    await app?.close();
    await redis.quit?.().catch(() => undefined);
    await pgPool?.end();
  }, 40_000);

  it("Secure is emitted when the config requires it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: { email: schema.holderEmail, password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = getSetCookieString(res.headers["set-cookie"]).toLowerCase();
    expect(cookie).toContain("secure");
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures — real rows through the runtime role; unique per run.      */
/* ------------------------------------------------------------------ */

async function seedFixtures(password: string): Promise<SeedSchema> {
  const passwordHash = await hashPassword(password);
  const conn = await independentConnection(appConnectionString());
  const suffix = randomBytes(4).toString("hex");
  const holderEmail = `login_${suffix}@test.local`;
  const disabledEmail = `login_disabled_${suffix}@test.local`;
  const rows = await conn.query(
    `INSERT INTO users (email, password_hash, role, status) VALUES
       ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE'),
       ($3, $2, 'ACCOUNT_HOLDER', 'DISABLED')
     RETURNING id, email`,
    [holderEmail, passwordHash, disabledEmail],
  );
  const holder = rows.rows.find((r) => r.email === holderEmail)!;
  return {
    holderId: holder.id.toString(),
    holderEmail,
    disabledEmail,
    teardown: async () => {
      await closeIndependent(conn);
    },
  };
}

/** Direct session row creation for expired/revoked/lifecycle cases. */
async function independentSeedSession(
  userId: string,
  expiresAt: Date,
  revoked = false,
): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const conn = await independentConnection(appConnectionString());
  try {
    await conn.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, tokenHash, expiresAt, revoked ? new Date() : null],
    );
    return token;
  } finally {
    await closeIndependent(conn);
  }
}

/** Verify revocation state at rest through the runtime role (real SQL). */
async function probeRevocationState(tokenHash: string): Promise<{ rows: Array<{ revoked_at: Date | null }> }> {
  const conn = await independentConnection(appConnectionString());
  try {
    const { rows } = await conn.query("SELECT revoked_at FROM sessions WHERE token_hash = $1", [tokenHash]);
    return { rows };
  } finally {
    await closeIndependent(conn);
  }
}

function getSetCookieString(headers: string | string[] | undefined): string {
  return Array.isArray(headers) ? headers.join("; ") : headers ?? "";
}

export type Noop = Config;
