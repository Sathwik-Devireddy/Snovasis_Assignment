import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { appConnectionString, bootstrapConnectionString, independentConnection, closeIndependent } from "../harness.js";
import { verifyPassword } from "../../src/infrastructure/argon2.js";

/**
 * PHASE-05 P5.9/P5.13 — first-admin bootstrap + rotation host commands
 * (BOOT-001/BOOT-002), executed as real subprocesses against REAL
 * PostgreSQL. The scripts are the system under test — never less.
 *
 * Because bootstrap is disabled once ANY ADMIN exists, the suite deletes the
 * rows of ITS marker family through the superuser connection (bootstrap role)
 * both before (idempotent across runs) and after (clean dev database).
 *
 * BOOT-001 additionally needs "no administrator exists AT ALL" — including an
 * administrator left by a deployment (the demo seed) or by another suite. The
 * helper below parks every other active administrator for the duration of the
 * test and restores it afterwards, so the assertion is about the SCRIPT's
 * behaviour, not about the state the database happened to be in. Without it the
 * suite only passes on a pristine database.
 */

const markerPrefix = "bootstrapt_";

/**
 * Disable every active administrator except the ones in `keepEmails`, and
 * return a restore function. Used to make "the only administrator" and
 * "no administrator exists" deterministic in a shared database.
 */
async function parkOtherAdmins(keepEmails: string[] = []): Promise<() => Promise<void>> {
  const superuser = await independentConnection(bootstrapConnectionString());
  try {
    const { rows } = await superuser.query<{ id: string; email: string }>(
      `SELECT id::text AS id, email FROM users
        WHERE role = 'ADMIN' AND status = 'ACTIVE' AND NOT (email = ANY($1::text[]))`,
      [keepEmails],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await superuser.query(
        `UPDATE users SET status = 'DISABLED' WHERE id = ANY($1::bigint[])`,
        [ids],
      );
    }
    return async () => {
      const restore = await independentConnection(bootstrapConnectionString());
      try {
        if (ids.length > 0) {
          await restore.query(
            `UPDATE users SET status = 'ACTIVE' WHERE id = ANY($1::bigint[])`,
            [ids],
          );
        }
      } finally {
        await closeIndependent(restore);
      }
    };
  } finally {
    await closeIndependent(superuser);
  }
}

function runBootstrap(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
  const merged = {
    // Test harness environment: the runtime-role URL the script requires.
    DATABASE_URL: appConnectionString(),
    BOOTSTRAP_ADMIN_EMAIL: `${markerPrefix}${randomBytes(5).toString("hex")}@test.local`,
    BOOTSTRAP_ADMIN_PASSWORD: `host-generated-pw-${randomBytes(8).toString("hex")}-0123456789`,
    ...env,
  };
  return spawnSync(process.execPath, [path.join("scripts", "bootstrap.mjs")], {
    env: merged,
    encoding: "utf8",
  });
}

function runRotation(env: Record<string, string | undefined>, args: string[] = []): ReturnType<typeof spawnSync> {
  const merged = { DATABASE_URL: appConnectionString(), ...env };
  return spawnSync(process.execPath, [path.join("scripts", "rotate-admin-credentials.mjs"), ...args], {
    env: merged,
    encoding: "utf8",
  });
}

async function purgeMarkerFamily(): Promise<void> {
  const superuser = await independentConnection(bootstrapConnectionString());
  try {
    // Clean up sessions and users (marker family only). audit_events is
    // append-only (trigger-guarded) so we do not delete from it — marker
    // family audit rows simply accumulate, which is harmless for tests.
    await superuser.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1 || '%')`, [markerPrefix]);
    await superuser.query(`DELETE FROM users WHERE email LIKE $1 || '%'`, [markerPrefix]);
  } finally {
    await closeIndependent(superuser);
  }
}

describe("first-admin bootstrap host command (real subprocesses; BOOT-001/002)", () => {
  beforeAll(async () => {
    await purgeMarkerFamily();
  });

  afterAll(async () => {
    // Leave the dev database clean: no marker-family admins behind.
    await purgeMarkerFamily();
  });

  it("creates the FIRST admin from env secrets: argon2id at rest, bootstrap_created audit event (BOOT-001)", async () => {
    const password = `host-generated-pw-${randomBytes(8).toString("hex")}-0123456789`;
    const email = `${markerPrefix}${randomBytes(5).toString("hex")}@test.local`;
    // "First" means FIRST: any other administrator in this database (a
    // deployment's admin, another suite's leftover) is parked for the test and
    // restored afterwards, so the assertion is about the script, not about the
    // state the shared database happened to be in.
    const restoreAdmins = await parkOtherAdmins();
    let run: ReturnType<typeof runBootstrap>;
    try {
      run = runBootstrap({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password });
    } finally {
      await restoreAdmins();
    }

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("bootstrap complete");
    expect(run.stdout).not.toContain(password); // plaintext NEVER printed

    const conn = await independentConnection(appConnectionString());
    try {
      const { rows } = await conn.query("SELECT id, role, status, password_hash FROM users WHERE email = $1", [email]);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("ADMIN");
      expect(rows[0].status).toBe("ACTIVE");
      expect(rows[0].password_hash.startsWith("$argon2id$")).toBe(true);
      expect(await verifyPassword(rows[0].password_hash, password)).toBe(true);

      const events = await conn.query(
        `SELECT event_type, actor_id, subject_id, metadata::text AS meta FROM audit_events
          WHERE event_type = 'bootstrap_created' AND subject_id = $1`,
        [String(rows[0].id)],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].actor_id).toBeNull(); // system:bootstrap attribution (claim, T-050)
      expect(events.rows[0].meta).toContain("system:bootstrap");
    } finally {
      await closeIndependent(conn);
    }
  });

  it("refuses when an admin already exists — one environment, one bootstrap (BOOT-002)", async () => {
    await purgeMarkerFamily(); // self-contained: BOOT-001's admin must not leak into this test
    // The first bootstrap of this test needs "no administrator exists" (the
    // second one then creates the precondition for the refusal) — park any
    // other administrator for the duration, as in BOOT-001.
    const restoreAdmins = await parkOtherAdmins();
    let first: ReturnType<typeof runBootstrap>;
    let second: ReturnType<typeof runBootstrap>;
    try {
      first = runBootstrap({});
      second = runBootstrap({}); // fresh email; still refused (any ADMIN exists)
    } finally {
      await restoreAdmins();
    }
    expect(first.status).toBe(0);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Refusing to bootstrap");
    expect(second.stderr).toContain("rotate-admin-credentials"); // points to the distinct procedure
  });

  it("refuses with missing env secrets and short passwords (fail fast, no side effects)", async () => {
    const noEmail = runBootstrap({ BOOTSTRAP_ADMIN_EMAIL: undefined });
    expect(noEmail.status).toBe(1);
    expect(noEmail.stderr).toContain("BOOTSTRAP_ADMIN_EMAIL");

    const noPassword = runBootstrap({ BOOTSTRAP_ADMIN_PASSWORD: undefined });
    expect(noPassword.status).toBe(1);
    expect(noPassword.stderr).toContain("BOOTSTRAP_ADMIN_PASSWORD");

    const shortPassword = runBootstrap({ BOOTSTRAP_ADMIN_PASSWORD: "too-short-pw" });
    expect(shortPassword.status).toBe(1);
    expect(shortPassword.stderr).toContain("at least 16");
  });
});

describe("rotate-admin-credentials host command (real subprocesses; §C.1.3)", () => {
  let adminEmail!: string;
  let adminPassword!: string;
  let adminId!: string;
  let conn!: PoolClient;

  beforeAll(async () => {
    await purgeMarkerFamily();
    // Seed the target admin directly (the bootstrap script path is proven above).
    adminPassword = `initial-pw-${randomBytes(8).toString("hex")}-0123456789`;
    adminEmail = `${markerPrefix}rotate_${randomBytes(5).toString("hex")}@test.local`;
    conn = await independentConnection(appConnectionString());
    const { hash } = await import("argon2");
    const encoded = await hash(adminPassword, { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows } = await conn.query(
      `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE') RETURNING id`,
      [adminEmail, encoded],
    );
    adminId = String(rows[0].id);
  });

  afterAll(async () => {
    await closeIndependent(conn).catch(() => undefined);
    await purgeMarkerFamily();
  });

  const rotationEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    LEDGERLINE_OPERATOR_ID: `op-session-${randomBytes(4).toString("hex")}`,
    ROTATE_ADMIN_EMAIL: adminEmail,
    ROTATE_ADMIN_PASSWORD: `rotated-pw-${randomBytes(8).toString("hex")}-0123456789`,
    ROTATION_CONFIRMED_PHRASE: "ROTATE-ADMIN-CREDENTIALS",
    BOOTSTRAP_ALLOW_ROTATION_CI: "true",
    ...overrides,
  });

  it("CLI-supplied operator is refused — the operator claim must come from the host environment", () => {
    const run = runRotation({ LEDGERLINE_OPERATOR_ID: undefined }, ["--operator", "forged-from-cli"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/refus/i);
    expect(run.stderr).toContain("LEDGERLINE_OPERATOR_ID");
  });

  it("non-interactive runs without the explicit CI export are refused (default-deny context)", () => {
    const run = runRotation(rotationEnv({ BOOTSTRAP_ALLOW_ROTATION_CI: undefined }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("non-interactive");
  });

  it("a wrong confirmation phrase is refused", () => {
    const run = runRotation(rotationEnv({ ROTATION_CONFIRMED_PHRASE: "PLEASE-CHANGE-PASSWORD" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("confirmation phrase");
  });

  it("rotates credentials, revokes ALL of the admin's sessions in the SAME transaction, and audits admin_credential_rotation", async () => {
    // Precondition: an ACTIVE session exists for the admin (stolen-credential scenario).
    const { randomBytes: rb, createHash } = await import("node:crypto");
    const token = rb(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    await conn.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [adminId, tokenHash]);
    // The old password still verifies as current.
    const before = await conn.query("SELECT password_hash FROM users WHERE id = $1", [adminId]);
    expect(await verifyPassword(before.rows[0].password_hash, adminPassword)).toBe(true);

    const newPassword = `rotated-pw-${randomBytes(8).toString("hex")}-0123456789`;
    const run = runRotation({ ...rotationEnv({ ROTATE_ADMIN_PASSWORD: newPassword }) });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("credential rotation complete");
    expect(run.stdout).not.toContain(newPassword);

    // Same-transaction effects: new argon2id hash + session revoked + distinct audit event.
    const after = await conn.query("SELECT password_hash FROM users WHERE id = $1", [adminId]);
    expect(await verifyPassword(after.rows[0].password_hash, newPassword)).toBe(true);
    expect(await verifyPassword(after.rows[0].password_hash, adminPassword)).toBe(false);

    const sessions = await conn.query("SELECT revoked_at FROM sessions WHERE user_id = $1", [adminId]);
    for (const row of sessions.rows) {
      expect(row.revoked_at).not.toBeNull();
    }

    const audit = await conn.query(
      `SELECT metadata::text AS meta FROM audit_events WHERE event_type = 'admin_credential_rotation' AND subject_id = $1`,
      [adminId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].meta).toContain("operator_claim");
    expect(audit.rows[0].meta).toContain("operator_context");
  });

  it("rotating a non-admin target is refused (active ADMIN only)", async () => {
    const holderEmail = `${markerPrefix}holder_${randomBytes(4).toString("hex")}@test.local`;
    await conn.query(
      `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ACCOUNT_HOLDER', 'ACTIVE')`,
      [holderEmail, await hashForTest()],
    );
    const run = runRotation(rotationEnv({ ROTATE_ADMIN_EMAIL: holderEmail }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("active ADMIN");
  });
});

async function hashForTest(): Promise<string> {
  const { hash } = await import("argon2");
  return await hash(`throwaway-pw-${randomBytes(6).toString("hex")}-0123456789`, { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
