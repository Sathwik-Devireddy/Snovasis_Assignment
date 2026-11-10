/**
 * First-admin bootstrap (PHASE-05 P5.9; AUTHZ_MATRIX §C.1/§C.1.3; BOOT-001/002).
 *
 *   node --env-file=../../.env scripts/bootstrap.mjs
 *
 * Out-of-band host command — NEVER reachable through the public API.
 * Inputs come from the HOST ENVIRONMENT only (no CLI argument may carry a
 * secret; the plaintext password never enters repo/chat/logs — T-015/T-034):
 *
 *   BOOTSTRAP_ADMIN_EMAIL      e.g. admin@balancevault.local
 *   BOOTSTRAP_ADMIN_PASSWORD   long, host-generated random value
 *
 * Guarantees:
 *   - refuses (exit 1) when any ADMIN user already exists — bootstrap runs
 *     once per environment; there is NO override path through bootstrap
 *     (approved decision 12; rotation is the separate, distinct command);
 *   - connects as the RUNTIME role (`ledgerline_app`, ADR-005: minimal
 *     privilege — this script may only INSERT a user + audit event);
 *   - stores ONLY an argon2id hash; emits the `bootstrap_created` audit
 *     event attributed to actor `system:bootstrap` (actor_id NULL, recorded
 *     in metadata).
 */

import url from "node:url";

const required = (name) => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`Missing ${name} in the environment. Refusing to bootstrap (secrets only travel via env).`);
    process.exit(1);
  }
  return v;
};

const email = required("BOOTSTRAP_ADMIN_EMAIL");
const password = required("BOOTSTRAP_ADMIN_PASSWORD");
const databaseUrl = required("DATABASE_URL"); // runtime role (ledgerline_app)

if (!email.includes("@") || email.length > 254) {
  console.error("BOOTSTRAP_ADMIN_EMAIL is not a plausible email address.");
  process.exit(1);
}
if (password.length < 16) {
  console.error("BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters (host-generated).");
  process.exit(1);
}

const { Pool } = await import("pg");
const { hash, verify } = await import("argon2");

// Same OWASP parameters as the API hasher (infrastructure/argon2.ts).
const ARGON2ID = { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Approved decision (§C.1.3): disabled once an administrator exists.
    const { rows } = await client.query(
      "SELECT count(*)::int AS admins FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'",
    );
    if (rows[0].admins > 0) {
      await client.query("ROLLBACK");
      console.error(
        `Refusing to bootstrap: ${rows[0].admins} active ADMIN user(s) already exist. ` +
          "Bootstrap is disabled once an administrator exists (AUTHZ_MATRIX §C.1.3). " +
          "Credential recovery is the separate rotate-admin-credentials command.",
      );
      process.exit(1);
    }

    const passwordHash = await hash(password, ARGON2ID);
    if (!passwordHash.startsWith("$argon2id$")) {
      throw new Error("hasher did not produce argon2id");
    }
    // Sensitivity check: prove the hash does NOT contain the plaintext.
    const plaintextLeak = passwordHash.includes(password);
    if (plaintextLeak || (await verify(passwordHash, password)) === false) {
      throw new Error("argon2id round-trip failed");
    }

    const inserted = await client.query(
      `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'ADMIN', 'ACTIVE') RETURNING id`,
      [email.toLowerCase(), passwordHash],
    );
    const adminId = inserted.rows[0].id;

    // The audit event of record for bootstrap creation (§C.1 item 4).
    await client.query(
      `INSERT INTO audit_events (actor_id, event_type, subject_type, subject_id, metadata)
       VALUES (NULL, 'bootstrap_created', 'user', $1, $2)`,
      [
        String(adminId),
        JSON.stringify({
          attributed_to: "system:bootstrap", // host-sourced attribution claim (T-050 residual, disclosed)
          role: "ADMIN",
          invocation: url.fileURLToPath(import.meta.url),
          hostname: process.env.HOSTNAME ?? null,
        }),
      ],
    );

    await client.query("COMMIT");
    console.log(`bootstrap complete: first ADMIN user created (id=${adminId}).`);
    console.log("The plaintext password is NOT stored, logged or printed — only its argon2id hash.");
  } finally {
    client.release();
  }
} catch (error) {
  console.error("bootstrap FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await pool.end().catch(() => undefined);
}
