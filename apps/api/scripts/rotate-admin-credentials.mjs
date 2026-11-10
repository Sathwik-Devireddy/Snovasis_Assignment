/**
 * rotate-admin-credentials (PHASE-05 P5.9; AUTHZ_MATRIX §C.1.3 decision 12).
 *
 *   node --env-file=../../.env scripts/rotate-admin-credentials.mjs
 *
 * The SEPARATE credential-recovery command — never a bootstrap re-run, never
 * reachable through the public API. All inputs come from the host environment;
 * CLI-supplied operator ids are REFUSED (Rev 3/#7). Safeguards (§C.1.3):
 *
 *   LEDGERLINE_OPERATOR_ID      operator claim from the trusted host env — a
 *                               CLI/--operator flag is refused by design;
 *   ROTATE_ADMIN_EMAIL / ROTATE_NEW_PASSWORD   target + new host-generated secret;
 *   typed confirmation phrase: the operator must type exactly
 *                               `ROTATE-ADMIN-CREDENTIALS`;
 *   refused in non-interactive (CI) contexts by default — only the explicit
 *                               host export BOOTSTRAP_ALLOW_ROTATION_CI=true
 *                               permits it;
 *   the target admin's sessions are revoked IN THE SAME TRANSACTION.
 *
 * Audit event of record: `admin_credential_rotation` (distinct from
 * `bootstrap_created`) with the operator claim + operator_context — honestly
 * labelled a CLAIM, not identity proof (T-050 accepted residual).
 */

import { hostname } from "node:os";

const nonEmpty = (name) => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`Missing ${name} in the environment. Refusing (secrets only travel via env).`);
    process.exit(1);
  }
  return v;
};

const operatorId = nonEmpty("LEDGERLINE_OPERATOR_ID");
const email = nonEmpty("ROTATE_ADMIN_EMAIL");
const newPassword = nonEmpty("ROTATE_ADMIN_PASSWORD"); // host-generated, >= 16 chars
const databaseUrl = nonEmpty("DATABASE_URL");

if (process.argv.slice(2).includes("--operator") || process.argv.slice(2).includes("-o")) {
  console.error("Refused: an operator id supplied on the command line is never trusted (AUTHZ_MATRIX §C.1.3) — LEDGERLINE_OPERATOR_ID must come from the host environment.");
  process.exit(1);
}
if (newPassword.length < 16) {
  console.error("ROTATE_ADMIN_PASSWORD must be at least 16 characters (host-generated).");
  process.exit(1);
}

const isInteractive = process.stdin.isTTY === true;
const allowCi = process.env.BOOTSTRAP_ALLOW_ROTATION_CI === "true";
if (!isInteractive && !allowCi) {
  console.error("Refused: rotation is refused in non-interactive/CI contexts by default (export BOOTSTRAP_ALLOW_ROTATION_CI=true explicitly on the host to allow it).");
  process.exit(1);
}

// Exact typed confirmation phrase (never a CLI flag, never implied).
let typed = "";
if (isInteractive) {
  console.error("Type exactly ROTATE-ADMIN-CREDENTIALS to confirm credential rotation:");
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    typed = String(chunk).trim();
    break;
  }
} else {
  typed = process.env.ROTATION_CONFIRMED_PHRASE ?? "";
}
if (typed !== "ROTATE-ADMIN-CREDENTIALS") {
  console.error("Refused: the exact typed confirmation phrase was not provided.");
  process.exit(1);
}

const { Pool } = await import("pg");
const { hash } = await import("argon2");

const ARGON2ID = { type: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Admin-lifecycle lock order (§C.2/§D.6): target sessions FOR UPDATE
    // (ascending id) BEFORE the target users row. Not a count-reducing
    // operation, so the admin_control singleton is not required here.
    const target = await client.query("SELECT id, role, status FROM users WHERE email = $1", [email.toLowerCase()]);
    if (target.rows.length !== 1) {
      await client.query("ROLLBACK");
      console.error("Refused: target admin user not found (rotation never reveals which emails exist).");
      process.exit(1);
    }
    const admin = target.rows[0];
    if (admin.role !== "ADMIN" || admin.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      console.error("Refused: rotation targets an active ADMIN only.");
      process.exit(1);
    }

    const sessions = await client.query(
      "SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id ASC FOR UPDATE",
      [admin.id],
    );
    const rows = await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [admin.id]);

    const passwordHash = await hash(newPassword, ARGON2ID);
    if (!passwordHash.startsWith("$argon2id$")) throw new Error("hasher did not produce argon2id");

    await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [admin.id, passwordHash]);
    // Same-transaction revocation: rotated credentials cannot ride old sessions.
    await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [admin.id]);

    await client.query(
      `INSERT INTO audit_events (actor_id, event_type, subject_type, subject_id, metadata)
       VALUES (NULL, 'admin_credential_rotation', 'user', $1, $2)`,
      [
        String(admin.id),
        JSON.stringify({
          operator_claim: operatorId, // CLAIM, not identity proof (T-050, disclosed)
          operator_context: {
            hostname: hostname(),
            invocation_source: "host-environment (node process)",
            sessions_revoked: sessions.rowCount ?? sessions.rows.length,
            users_locked: rows.rowCount,
          },
          target_email: email.toLowerCase(),
        }),
      ],
    );

    await client.query("COMMIT");
    console.log(`credential rotation complete for ADMIN id=${admin.id}; ${sessions.rows.length} session(s) revoked in the same transaction.`);
  } finally {
    client.release();
  }
} catch (error) {
  console.error("rotation FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await pool.end().catch(() => undefined);
}
