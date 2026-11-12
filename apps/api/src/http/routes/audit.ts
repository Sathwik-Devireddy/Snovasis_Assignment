import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { buildAuthenticate, type SessionDeps } from "../../auth/session.js";
import { DomainError } from "../errors.js";
import { isInt64Token } from "../../domain/money.js";

/**
 * GET /audit/events — administrative audit query (PHASE-10 P10.3;
 * REFUSAL_CODES A8: internal reason codes are audit-view content, permitted
 * here for ADMIN/AUDITOR; never exposed to holders).
 *
 * Access: ADMIN or AUDITOR see all audit events; any other actor receives the
 * single uniform 404 `ACCOUNT_NOT_FOUND` envelope (deny-by-default).
 *
 * Read-only: never mutates balances, journals, attempts, or audit records.
 * Keyset pagination on (occurred_at, id); limit clamped 1..200, default 50;
 * opaque base64url cursor; malformed cursor -> 400 VALIDATION_FAILED.
 * Metadata contains no secrets (audit writes record role/grant/internal
 * reason only); it is returned as-is to entitled auditor/admin viewers.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const AuditQuery = z
  .object({
    limit: z.string().regex(/^\d{1,4}$/).optional(),
    cursor: z.string().optional(),
    event_type: z.string().optional(),
    subject_type: z.string().optional(),
    actor_id: z.string().regex(/^\d{1,19}$/).refine(isInt64Token).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

type AuditCursor = { ts: string | null; id: string | null };

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): AuditCursor {
  if (raw === undefined || raw === "") return { ts: null, id: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Validation failed.");
  }
  const c = parsed as AuditCursor;
  const valid =
    typeof c === "object" &&
    c !== null &&
    (c.ts === null || typeof c.ts === "string") &&
    (c.id === null || (typeof c.id === "string" && isInt64Token(c.id)));
  if (!valid) throw new DomainError("VALIDATION_FAILED", "Validation failed.");
  if (c.ts !== null && Number.isNaN(Date.parse(c.ts))) throw new DomainError("VALIDATION_FAILED", "Validation failed.");
  return { ts: c.ts, id: c.id };
}

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; sessions: SessionDeps },
) {
  const authenticate = buildAuthenticate(deps.sessions);
  app.get(
    "/audit/events",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const actor = (request as { actor: { id: string; role: string } }).actor;
      if (!actor || (actor.role !== "ADMIN" && actor.role !== "AUDITOR")) {
        throw new DomainError("ACCOUNT_NOT_FOUND", "Account not found.");
      }
      const query = AuditQuery.safeParse(request.query);
      if (!query.success) {
        throw new DomainError("VALIDATION_FAILED", "Validation failed.");
      }
      const { limit: limitRaw, cursor: cursorRaw, event_type, subject_type, actor_id, from, to } = query.data;

      const limit = limitRaw === undefined ? DEFAULT_LIMIT : Math.min(Math.max(Number(limitRaw), 1), MAX_LIMIT);
      const cursor = decodeCursor(cursorRaw);

      const client = await deps.pgPool.connect();
      try {
        const { rows } = await client.query<{
          id: string;
          occurred_at: Date;
          actor_id: string | null;
          event_type: string;
          subject_type: string | null;
          subject_id: string | null;
          reason_code: string | null;
          metadata: unknown;
        }>(
          `SELECT ae.id::text AS id, ae.occurred_at, ae.actor_id::text AS actor_id,
                  ae.event_type, ae.subject_type, ae.subject_id::text AS subject_id,
                  ae.reason_code, ae.metadata
             FROM audit_events ae
            WHERE ($1::text IS NULL OR ae.event_type = $1::text)
              AND ($2::text IS NULL OR ae.subject_type = $2::text)
              AND ($3::bigint IS NULL OR ae.actor_id = $3::bigint)
              AND ($4::timestamptz IS NULL OR ae.occurred_at >= $4::timestamptz)
              AND ($5::timestamptz IS NULL OR ae.occurred_at <= $5::timestamptz)
              AND ($6::timestamptz IS NULL
                   OR (ae.occurred_at, ae.id) > ($6::timestamptz, $7::bigint))
            ORDER BY ae.occurred_at ASC, ae.id ASC
            LIMIT $8`,
          [
            event_type ?? null,
            subject_type ?? null,
            actor_id === undefined || actor_id === "" ? null : BigInt(actor_id),
            from ?? null,
            to ?? null,
            cursor.ts === null ? null : cursor.ts,
            cursor.id === null ? null : BigInt(cursor.id),
            limit + 1,
          ],
        );

        const events = rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at.toISOString(),
          actorId: r.actor_id,
          eventType: r.event_type,
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          reasonCode: r.reason_code,
          metadata: r.metadata,
        }));

        const hasMore = events.length > limit;
        const emitted = hasMore ? events.slice(0, limit) : events;
        const last = emitted[emitted.length - 1];
        const nextCursor = hasMore ? encodeCursor({ ts: last!.occurredAt, id: last!.id }) : null;

        return await reply.code(200).send({ events: emitted, nextCursor });
      } finally {
        client.release();
      }
    },
  );
}
