/**
 * PHASE-06 P6.9 — account lifecycle routes (API_CONTRACT "Accounts").
 *
 *   POST /accounts      — ADMIN only: create a CUSTOMER (zero balance) or
 *                         SYSTEM account; audited in the SAME transaction
 *                         (AC2.1: opening funds must be a separate deposit).
 *   GET  /accounts      — ADMIN/AUDITOR: all accounts; ACCOUNT_HOLDER: only
 *                         accounts with an active VIEW grant (deny-by-default).
 *   GET  /accounts/:id  — detail incl. server balance; holders need VIEW,
 *                         otherwise the uniform 404 ACCOUNT_NOT_FOUND envelope.
 *
 * v1 is INR-only: creation refuses other currencies at the validation edge.
 * The runtime role has INSERT on accounts (migration 0005) but no UPDATE
 * outside the decided column list and never DELETE — account lifecycle beyond
 * creation (suspend/close, §F) arrives with the admin-lifecycle phase.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { buildAuthenticate } from "../../auth/session.js";
import type { Config } from "../../config.js";
import type { PrismaClient } from "../../infrastructure/prisma.js";
import { assertMutationHeaders } from "../guards.js";
import { DomainError } from "../errors.js";
import { SYSTEM_CURRENCY } from "../../domain/money.js";

const CreateAccountBody = z
  .object({
    accountNumber: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    currencyCode: z.string().length(3),
    kind: z.enum(["CUSTOMER", "SYSTEM"]),
    status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]).default("ACTIVE"),
  })
  .strict();

const ListQuery = z
  .object({
    status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
    kind: z.enum(["CUSTOMER", "SYSTEM"]).optional(),
  })
  .strict();

type AccountRow = {
  id: string | number | bigint;
  account_number: string;
  label: string;
  currency_code: string;
  kind: string;
  status: string;
  balance_minor: string | number | bigint | null;
  event_last_seq: string | number | bigint | null;
};

function serializeAccount(row: AccountRow) {
  return {
    id: row.id.toString(),
    accountNumber: row.account_number,
    label: row.label,
    currencyCode: row.currency_code,
    kind: row.kind,
    status: row.status,
    balanceMinor: row.balance_minor === null ? null : row.balance_minor.toString(),
    eventLastSeq: row.event_last_seq === null ? null : row.event_last_seq.toString(),
  };
}

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; prisma: PrismaClient; config: Config },
): void {
  const { pgPool, prisma, config: cfg } = deps;
  const authenticate = buildAuthenticate({
    prisma,
    sessionTtlSeconds: cfg.SESSION_TTL_SECONDS,
    cookieSecure: cfg.COOKIE_SECURE === "true",
  });

  // POST /accounts — ADMIN only, one transaction: account + audit row.
  app.post(
    "/accounts",
    { preHandler: [authenticate, assertMutationHeaders] },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor || actor.role !== "ADMIN") {
        throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND", "FORBIDDEN");
      }
      const parsed = CreateAccountBody.safeParse(request.body);
      if (!parsed.success) {
        throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED");
      }
      const { accountNumber, label, currencyCode, kind, status } = parsed.data;
      if (currencyCode !== SYSTEM_CURRENCY) {
        // v1 single-currency system (REFUSAL_CODES §2); nothing durable happened.
        throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED");
      }
      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        try {
          // CUSTOMER rows open at exactly zero balance/counter (AC2.1);
          // SYSTEM rows carry no cached balance (P6.1 shape CHECK).
          const { rows } = await client.query<{ id: string | number }>(
            `INSERT INTO accounts (account_number, label, currency_code, kind, status,
                                   balance_minor, event_last_seq)
             VALUES ($1, $2, $3, $4, $5,
                     CASE WHEN $4 = 'CUSTOMER' THEN 0 ELSE NULL END,
                     CASE WHEN $4 = 'CUSTOMER' THEN 0 ELSE NULL END)
             RETURNING id`,
            [accountNumber, label, currencyCode, kind, status],
          );
          if (rows.length === 0) {
            throw new DomainError("INFRA_FAILURE", "INFRA_FAILURE", "account insert returned no id");
          }
          const accountId = BigInt(rows[0]!.id);
          await client.query(
            `INSERT INTO audit_events (actor_id, event_type, subject_type, subject_id, metadata)
             VALUES ($1, 'ACCOUNT_CREATED', 'account', $2, $3)`,
            [BigInt(actor.id), accountId.toString(), JSON.stringify({ accountNumber, kind, currencyCode, status })],
          );
          await client.query("COMMIT");
          return await reply.code(201).send({
            account: {
              id: accountId.toString(),
              accountNumber,
              label,
              currencyCode,
              kind,
              status,
              balanceMinor: kind === "CUSTOMER" ? "0" : null,
              eventLastSeq: kind === "CUSTOMER" ? "0" : null,
            },
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if ((error as { code?: string }).code === "23505") {
            throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED", "ACCOUNT_NUMBER_TAKEN");
          }
          throw error;
        }
      } finally {
        client.release();
      }
    },
  );

  // GET /accounts — list; holders see only VIEW-granted accounts.
  app.get("/accounts", { preHandler: [authenticate] }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED");
    const parsed = ListQuery.safeParse(request.query ?? {});
    if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "VALIDATION_FAILED");

    const params: unknown[] = [];
    let sqlText =
      `SELECT a.id, a.account_number, a.label, a.currency_code, a.kind, a.status,
              a.balance_minor, a.event_last_seq
         FROM accounts a
        WHERE 1 = 1`;
    if (actor.role === "ACCOUNT_HOLDER") {
      params.push(BigInt(actor.id));
      sqlText += ` AND EXISTS (
        SELECT 1 FROM account_permissions p
         WHERE p.user_id = $${params.length} AND p.account_id = a.id
           AND p.revoked_at IS NULL AND p.permission = 'VIEW')`;
    }
    if (parsed.data.kind !== undefined) {
      params.push(parsed.data.kind);
      sqlText += ` AND a.kind = $${params.length}`;
    }
    if (parsed.data.status !== undefined) {
      params.push(parsed.data.status);
      sqlText += ` AND a.status = $${params.length}`;
    }
    sqlText += ` ORDER BY a.id ASC`;

    const client = await pgPool.connect();
    try {
      const { rows } = await client.query<AccountRow>(sqlText, params);
      return await reply.code(200).send({ accounts: rows.map(serializeAccount) });
    } finally {
      client.release();
    }
  });

  // GET /accounts/:id — detail; holders need VIEW, else uniform 404.
  app.get("/accounts/:accountId", { preHandler: [authenticate] }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED");
    const raw = (request.params as { accountId: string }).accountId;
    if (!/^\d{1,19}$/.test(raw)) {
      throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
    }
    const accountId = BigInt(raw);

    const client = await pgPool.connect();
    try {
      const { rows } = await client.query<AccountRow>(
        `SELECT a.id, a.account_number, a.label, a.currency_code, a.kind, a.status,
                a.balance_minor, a.event_last_seq
           FROM accounts a
          WHERE a.id = $1
            AND ($2 = 'ADMIN' OR $2 = 'AUDITOR' OR EXISTS (
              SELECT 1 FROM account_permissions p
               WHERE p.user_id = $3 AND p.account_id = a.id
                 AND p.revoked_at IS NULL AND p.permission = 'VIEW'))`,
        [accountId, actor.role, BigInt(actor.id)],
      );
      if (rows.length === 0) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "ACCOUNT_NOT_FOUND");
      }
      const row = rows[0]!;
      return await reply.code(200).send({ account: serializeAccount(row) });
    } finally {
      client.release();
    }
  });
}
