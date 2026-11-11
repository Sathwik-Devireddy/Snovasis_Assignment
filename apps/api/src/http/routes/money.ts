/**
 * PHASE-06 P6.9 — money command routes (API_CONTRACT "Money movement").
 *
 *   POST /accounts/:accountId/deposits    — ADMIN only (H-2, cash desk)
 *   POST /accounts/:accountId/withdrawals — ADMIN role-level or WITHDRAW grant
 *   POST /transfers                        — TRANSFER grant on the source
 *
 * Every route:
 *   1. authenticates (session cookie → request.actor; a revoked/expired
 *      session is 401 UNAUTHENTICATED — never a 404),
 *   2. enforces mutation guards (Origin + Content-Type, P5.6),
 *   3. rate-limits per actor (Redis fixed window; fail-soft T-060; a refused
 *      429 has zero side effects on durable state by construction),
 *   4. transport-validates the body/headers (400, no attempt row),
 *   5. hands the command to runMoneyCommand — ONE raw-pg transaction
 *      (ADR-005; Prisma is never opened here, TX-BOUNDARY-001),
 *   6. maps DomainErrors through the shared error handler (uniform envelopes).
 *
 * Idempotency: the key travels in the `Idempotency-Key` header (client
 * contract: one key per user-intent, reused on every retry). The canonical
 * request hash covers exactly the fields validated into the command.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { buildAuthenticate } from "../../auth/session.js";
import type { Config } from "../../config.js";
import type { PrismaClient } from "../../infrastructure/prisma.js";
import { assertMutationHeaders } from "../guards.js";
import { DomainError } from "../errors.js";
import { rateLimiter, type RateLimitDeps } from "../../infrastructure/rateLimiter.js";
import { runMoneyCommand, type MoneyCommand } from "../../domain/transactionRunner.js";
import { canonicalHash, parseMinor } from "../../domain/money.js";

const IdempotencyKeyHeader = z
  .string()
  .min(1, "missing Idempotency-Key")
  .max(64, "Idempotency-Key too long");

/** Opaque public account ids are decimal BIGINT strings (opaque, sequenced). */
const AccountRef = z.string().regex(/^\d{1,19}$/, "invalid account id");

const AmountToken = z.string().regex(/^-?\d{1,19}$/, "invalid amount_minor token");

const BodyCurrency = z.string().length(3, "currency must be a 3-letter code");

const OptionalDescription = z.string().max(500).optional();

const DepositBody = z.object({ amountMinor: AmountToken, currencyCode: BodyCurrency, description: OptionalDescription }).strict();
const WithdrawalBody = z.object({ amountMinor: AmountToken, currencyCode: BodyCurrency, description: OptionalDescription }).strict();
const TransferBody = z
  .object({
    sourceAccountId: AccountRef,
    destinationAccountId: AccountRef,
    amountMinor: AmountToken,
    currencyCode: BodyCurrency,
    description: OptionalDescription,
  })
  .strict();

function validationFailed(message: string): never {
  throw new DomainError("VALIDATION_FAILED", message);
}

function requireIdempotencyKey(request: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = IdempotencyKeyHeader.safeParse(value);
  if (!parsed.success) validationFailed("Idempotency-Key header must be 1-64 characters");
  return parsed.data;
}

function parseAccountId(ref: string): bigint {
  const parsed = AccountRef.safeParse(ref);
  if (!parsed.success) validationFailed("invalid account id");
  return BigInt(parsed.data);
}

/** Transport amount boundary: malformed / beyond-64-bit tokens are 400s. */
function parseAmountOr400(token: string): bigint {
  try {
    return parseMinor(token);
  } catch {
    validationFailed("amount_minor must be a decimal integer string within the signed 64-bit range");
  }
}

function requireActor(
  request: { actor?: { id: string; role: string; status: string; sessionId: string } },
): { id: bigint; sessionId: bigint } {
  const actor = request.actor;
  if (!actor) throw new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED");
  return { id: BigInt(actor.id), sessionId: BigInt(actor.sessionId) };
}

/** Success envelope; refusals arrive as mapped DomainErrors. */
function successEnvelope(journalTransactionId: bigint, replayed: boolean) {
  return {
    status: "SUCCEEDED",
    journalTransactionId: journalTransactionId.toString(),
    replayed,
  };
}

export function registerMoneyRoutes(
  app: FastifyInstance,
  deps: { pgPool: Pool; prisma: PrismaClient; config: Config; rateLimits: RateLimitDeps },
): void {
  const { pgPool, config: cfg, rateLimits } = deps;
  const authenticate = buildAuthenticate({
    prisma: deps.prisma,
    sessionTtlSeconds: cfg.SESSION_TTL_SECONDS,
    cookieSecure: cfg.COOKIE_SECURE === "true",
  });
  const limiter = rateLimiter("money", rateLimits);

  const runCommand = async (
    request: { actor?: { id: string; role: string; status: string; sessionId: string } },
    command: MoneyCommand,
  ): Promise<{ statusCode: number; body: unknown }> => {
    const client = await pgPool.connect();
    try {
      const result = await runMoneyCommand(client, command);
      return { statusCode: 200, body: successEnvelope(result.journalTransactionId, result.replayed) };
    } finally {
      client.release();
    }
  };

  // POST /accounts/:accountId/deposits — external money-in (ADMIN, H-2)
  app.post(
    "/accounts/:accountId/deposits",
    { preHandler: [authenticate, assertMutationHeaders, limiter] },
    async (request, reply) => {
      requireActor(request); // route requires a session; role policy is enforced in-transaction
      const idempotencyKey = requireIdempotencyKey(request);
      const parsed = DepositBody.safeParse(request.body);
      if (!parsed.success) validationFailed("invalid deposit body");
      const accountId = parseAccountId((request.params as { accountId: string }).accountId);
      const amount = parseAmountOr400(parsed.data.amountMinor);
      const body = parsed.data;
      const command: MoneyCommand = {
        operation: "DEPOSIT",
        idempotencyKey,
        requestHash: canonicalHash({
          operation: "DEPOSIT",
          accountId: accountId.toString(),
          amountMinor: body.amountMinor,
          currencyCode: body.currencyCode,
          description: body.description ?? null,
        }),
        actorId: requireActor(request).id,
        sessionId: requireActor(request).sessionId,
        destinationAccountId: accountId,
        amount,
        currencyCode: body.currencyCode,
        suppliedDestinationRef: (request.params as { accountId: string }).accountId,
      };
      const out = await runCommand(request, command);
      return await reply.code(out.statusCode).send(out.body);
    },
  );

  // POST /accounts/:accountId/withdrawals — external money-out
  app.post(
    "/accounts/:accountId/withdrawals",
    { preHandler: [authenticate, assertMutationHeaders, limiter] },
    async (request, reply) => {
      requireActor(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const parsed = WithdrawalBody.safeParse(request.body);
      if (!parsed.success) validationFailed("invalid withdrawal body");
      const accountId = parseAccountId((request.params as { accountId: string }).accountId);
      const amount = parseAmountOr400(parsed.data.amountMinor);
      const body = parsed.data;
      const command: MoneyCommand = {
        operation: "WITHDRAWAL",
        idempotencyKey,
        requestHash: canonicalHash({
          operation: "WITHDRAWAL",
          accountId: accountId.toString(),
          amountMinor: body.amountMinor,
          currencyCode: body.currencyCode,
          description: body.description ?? null,
        }),
        actorId: requireActor(request).id,
        sessionId: requireActor(request).sessionId,
        sourceAccountId: accountId,
        amount,
        currencyCode: body.currencyCode,
        suppliedSourceRef: (request.params as { accountId: string }).accountId,
      };
      const out = await runCommand(request, command);
      return await reply.code(out.statusCode).send(out.body);
    },
  );

  // POST /transfers — internal transfer (debit source + credit destination)
  app.post(
    "/transfers",
    { preHandler: [authenticate, assertMutationHeaders, limiter] },
    async (request, reply) => {
      requireActor(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const parsed = TransferBody.safeParse(request.body);
      if (!parsed.success) validationFailed("invalid transfer body");
      const body = parsed.data;
      const amount = parseAmountOr400(body.amountMinor);
      const command: MoneyCommand = {
        operation: "TRANSFER",
        idempotencyKey,
        requestHash: canonicalHash({
          operation: "TRANSFER",
          sourceAccountId: body.sourceAccountId,
          destinationAccountId: body.destinationAccountId,
          amountMinor: body.amountMinor,
          currencyCode: body.currencyCode,
          description: body.description ?? null,
        }),
        actorId: requireActor(request).id,
        sessionId: requireActor(request).sessionId,
        sourceAccountId: BigInt(body.sourceAccountId),
        destinationAccountId: BigInt(body.destinationAccountId),
        amount,
        currencyCode: body.currencyCode,
        suppliedSourceRef: body.sourceAccountId,
        suppliedDestinationRef: body.destinationAccountId,
      };
      const out = await runCommand(request, command);
      return await reply.code(out.statusCode).send(out.body);
    },
  );
}
