import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import { registerHealthRoutes } from "./routes/health.js";
import { registerReadyRoutes } from "./routes/ready.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerRegisterRoute } from "./routes/register.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { mapToErrorResponse } from "./errorMapper.js";
import type { RedisLike } from "../infrastructure/redis.js";
import type { PrismaClient } from "../infrastructure/prisma.js";
import { buildRateLimitDepsFromEnv } from "../infrastructure/rateLimiter.js";
import type { Config } from "../config.js";
/**
 * Application factory (PHASE-04 P4.4): `buildApp(deps)` keeps all testable
 * connection objects injected — no hidden global pools inside request paths
 * (real-PostgreSQL test harness opens independent connections; kit P4.5).
 */

export type AppDeps = {
  config: Config;
  pgPool: Pool;
  redis: RedisLike;
  prisma: PrismaClient;
};

/** Never log credentials/tokens/full auth headers (LOG-001; kit P4.4). */
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.set-cookie",
  "req.body.password",
  "req.body.token",
  "req.body.idempotency_key",
  "password",
  "token",
  "password_hash",
  "token_hash",
];

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      redact: { paths: redactPaths, censor: "[REDACTED]" },
    },
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: 64 * 1024, // body-size limit (T-035); tightened per-route later
    requestIdHeader: false, // request ids are always server-generated
  });

  app.register(fastifyCookie);

  app.setErrorHandler((error, request, reply) => {
    const envelope = mapToErrorResponse(error);
    reply.code(envelope.statusCode).send(envelope.body);
  });

  // Expose the server-generated request id for client-side correlation/support,
  // without trusting any client-supplied id.
  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-request-id", request.id);
    done(null, payload);
  });

  registerHealthRoutes(app);
  registerReadyRoutes(app, {
    pgPool: deps.pgPool,
    redis: deps.redis,
  });

  // Phase 5 identity surface (P5.10/P5.11). The limiter + session deps come
  // from typed config; Prisma is the routine-CRUD client (ADR-005).
  const rateLimits = buildRateLimitDepsFromEnv(deps.config, deps.redis);
  const sessions = {
    prisma: deps.prisma,
    sessionTtlSeconds: deps.config.SESSION_TTL_SECONDS,
    cookieSecure: deps.config.COOKIE_SECURE === "true",
  };
  registerRegisterRoute(app, { prisma: deps.prisma, rateLimits });
  registerAuthRoutes(app, { prisma: deps.prisma, sessions, rateLimits });
  registerAdminRoutes(app, { pgPool: deps.pgPool, prisma: deps.prisma, config: deps.config });

  return app;
}
