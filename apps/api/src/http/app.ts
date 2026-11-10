import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { registerHealthRoutes } from "./routes/health.js";
import { registerReadyRoutes } from "./routes/ready.js";
import { mapToErrorResponse } from "./errorMapper.js";
import type { RedisLike } from "../infrastructure/redis.js";
import type { PrismaClient } from "../infrastructure/prisma.js";
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
  prisma: PrismaClient | null;
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

  app.setErrorHandler((error, request, reply) => {
    reply.send(mapToErrorResponse(error));
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

  return app;
}
