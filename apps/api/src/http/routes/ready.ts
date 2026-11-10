import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { RedisLike } from "../../infrastructure/redis.js";

/**
 * `/ready` — dependency readiness (PHASE-04 P4.4 + P4.4+ BalanceVault).
 * PostgreSQL AND Redis must be reachable. Reports availability ONLY — never
 * credentials, env values, or component error details (kit P4.4, THREATS T-015).
 * On partial failure: 503 with per-component ok/unavailable flags.
 */

export type ReadyDeps = {
  pgPool: Pool;
  redis: RedisLike;
};

export function registerReadyRoutes(app: FastifyInstance, deps: ReadyDeps) {
  app.get("/ready", async (_request, reply) => {
    const checks = {
      postgres: await pingPostgres(deps.pgPool),
      redis: await pingRedis(deps.redis),
    };
    const ok = checks.postgres === "ok" && checks.redis === "ok";
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });
}

async function pingPostgres(pool: Pool): Promise<"ok" | "unavailable"> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function pingRedis(redis: RedisLike): Promise<"ok" | "unavailable"> {
  try {
    await redis.ping();
    return "ok";
  } catch {
    return "unavailable";
  }
}
