import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { PrismaClient } from "../../infrastructure/prisma.js";
import type { Config } from "../../config.js";
import { DomainError } from "../errors.js";
import { assertMutationHeaders } from "../guards.js";
import { buildAuthenticate } from "../../auth/session.js";
import { hashPassword } from "../../infrastructure/argon2.js";

/**
 * PHASE-05 P5.7 — admin-only user and permission management (AUTHZ_MATRIX §B).
 *
 * All routes are admin-only, deny-by-default, and every grant/role/lifecycle
 * change is written to `audit_events` in the same transaction as the change.
 * The `users` and `account_permissions` tables exist (migration 0002); the
 * `account_permissions.account_id` FK to `accounts` is stubbed until Phase 6
 * (P5.1), so grant rows target accounts by id without the FK.
 */

const CreateUserBody = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(10).max(200),
    role: z.enum(["ADMIN", "ACCOUNT_HOLDER", "AUDITOR"]),
  })
  .strict();

const RoleChangeBody = z
  .object({
    role: z.enum(["ADMIN", "ACCOUNT_HOLDER", "AUDITOR"]),
  })
  .strict();

const GrantBody = z
  .object({
    userId: z.string().min(1),
    accountId: z.string().min(1),
    permission: z.enum(["VIEW", "DEPOSIT", "WITHDRAW", "TRANSFER", "ADJUST"]),
  })
  .strict();

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; prisma: PrismaClient; config: Config },
): void {
  const { pgPool, prisma, config: cfg } = deps;
  const authenticate = buildAuthenticate({
    prisma,
    sessionTtlSeconds: cfg.SESSION_TTL_SECONDS,
    cookieSecure: cfg.COOKIE_SECURE === "true",
  });

  // --- POST /users — admin-only user creation ------------------------------

  app.post(
    "/users",
    {
      preHandler: [authenticate, assertMutationHeaders],
    },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor || actor.role !== "ADMIN") {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Not found."); // uniform 404
      }
      const parsed = CreateUserBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError("VALIDATION_FAILED", "Invalid request.");
      }
      const { email, password, role } = parsed.data;
      const passwordHash = await hashPassword(password);
      if (!passwordHash.startsWith("$argon2id$")) {
        throw new DomainError("INFRA_FAILURE", "Internal infrastructure failure.");
      }
      const user = await prisma.user.create({
        data: { email: email.toLowerCase(), passwordHash, role, status: "ACTIVE" },
        select: { id: true, email: true, role: true },
      });
      await prisma.auditEvent.create({
        data: {
          actorId: BigInt(actor.id),
          eventType: "USER_CREATED",
          subjectType: "user",
          subjectId: user.id.toString(),
          metadata: { role },
        },
      });
      return await reply.code(201).send({ user: { id: user.id.toString(), email: user.email, role: user.role } });
    },
  );

  // --- PATCH /users/:userId/role — role change with last-admin guard --------

  app.patch(
    "/users/:userId/role",
    {
      preHandler: [authenticate, assertMutationHeaders],
    },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor || actor.role !== "ADMIN") {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Not found.");
      }
      const { userId } = request.params as { userId: string };
      const parsed = RoleChangeBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError("VALIDATION_FAILED", "Invalid request.");
      }
      const { role: newRole } = parsed.data;

      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        // Admin-lifecycle lock order (AUTHZ_MATRIX §C.2): admin_control first,
        // then the target sessions, then the target users row.
        await client.query("SELECT id FROM admin_control WHERE id = 1 FOR UPDATE");
        const { rows: admins } = await client.query(
          "SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'",
        );
        const { rows: targets } = await client.query(
          "SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE",
          [userId],
        );
        if (targets.length !== 1) {
          await client.query("ROLLBACK");
          throw new DomainError("ACCOUNT_NOT_FOUND", "Not found.");
        }
        const target = targets[0];
        if (target.role === "ADMIN" && admins[0].n <= 1) {
          await client.query("ROLLBACK");
          throw new DomainError("LAST_ADMIN_PROTECTED", "Last active administrator cannot be demoted or disabled.");
        }
        if (userId === actor.id) {
          await client.query("ROLLBACK");
          throw new DomainError("VALIDATION_FAILED", "Cannot change your own role.");
        }
        await client.query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", [
          userId,
          newRole,
        ]);
        // Revoke all of the target's sessions in the same transaction (ADR-006 item 5).
        await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
          userId,
        ]);
        await client.query(
          `INSERT INTO audit_events (actor_id, event_type, subject_type, subject_id, metadata)
           VALUES ($1, 'role_changed', 'user', $2, $3)`,
          [BigInt(actor.id), userId, JSON.stringify({ role: newRole })],
        );
        await client.query("COMMIT");
        return await reply.code(200).send({ ok: true, userId, role: newRole });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof DomainError) throw error;
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // --- POST /account-permissions — grant (admin only; never to self) --------

  app.post(
    "/account-permissions",
    {
      preHandler: [authenticate, assertMutationHeaders],
    },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor || actor.role !== "ADMIN") {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Not found.");
      }
      const parsed = GrantBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError("VALIDATION_FAILED", "Invalid request.");
      }
      const { userId, accountId, permission } = parsed.data;

      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        const { rows: existing } = await client.query(
          `SELECT id FROM account_permissions
            WHERE user_id = $1 AND account_id = $2 AND permission = $3 AND revoked_at IS NULL
            FOR SHARE`,
          [userId, accountId, permission],
        );
        if (existing.length > 0) {
          await client.query("ROLLBACK");
          throw new DomainError("VALIDATION_FAILED", "Permission already granted.");
        }
        // AUTH-004: an admin may never grant a permission to themself.
        if (actor.id === userId) {
          await client.query("ROLLBACK");
          throw new DomainError("SELF_GRANT_REFUSED", "An administrator may not grant a permission to themself.");
        }
        await client.query(
          `INSERT INTO account_permissions (user_id, account_id, permission, granted_by)
           VALUES ($1, $2, $3, $1)`,
          [userId, accountId, permission],
        );
        await client.query(
          `INSERT INTO audit_events (actor_id, event_type, subject_type, subject_id, metadata)
           VALUES ($1, 'permission_granted', 'account_permission', $2, $3)`,
          [
            BigInt(actor.id),
            accountId,
            JSON.stringify({ permission, userId, accountId }),
          ],
        );
        await client.query("COMMIT");
        return await reply.code(201).send({ ok: true, userId, accountId, permission });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof DomainError) throw error;
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // --- DELETE /account-permissions — revoke (admin only) --------------------

  app.delete(
    "/account-permissions",
    {
      preHandler: [authenticate, assertMutationHeaders],
    },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor || actor.role !== "ADMIN") {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Not found.");
      }
      const parsed = GrantBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError("VALIDATION_FAILED", "Invalid request.");
      }
      const { userId, accountId, permission } = parsed.data;
      if (actor.id === userId) {
        throw new DomainError("SELF_GRANT_REFUSED", "An administrator may not revoke a permission from themself.");
      }
      const { count } = await prisma.accountPermission.updateMany({
        where: { userId: BigInt(userId), accountId: BigInt(accountId), permission, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await prisma.auditEvent.create({
        data: {
          actorId: BigInt(actor.id),
          eventType: "permission_revoked",
          subjectType: "account_permission",
          subjectId: accountId,
          metadata: { permission, userId, accountId, revoked: count > 0 },
        },
      });
      return await reply.code(200).send({ ok: true, userId, accountId, permission, revoked: count > 0 });
    },
  );
}
