/**
 * Server entrypoint (PHASE-04 deploy preparation). Loads config fail-fast,
 * wires raw-pg pool + Redis + Prisma (routine path), builds the app with
 * `buildApp(deps)` and listens. The database connection is the RELATIONSHIP
 * the owner/runtime role separation is checked against at startup.
 */

import { loadConfig } from "./config.js";
import { createPgPool } from "./infrastructure/pg.js";
import { createRedisClient } from "./infrastructure/redis.js";
import { prismaClient } from "./infrastructure/prisma.js";
import { buildApp } from "./http/app.js";

async function main() {
  const cfg = loadConfig();

  const pgPool = createPgPool({ connectionString: cfg.DATABASE_URL });
  const redis = createRedisClient({ url: cfg.REDIS_URL, lazyConnect: true });
  const prisma = prismaClient();

  const app = buildApp({ config: cfg, pgPool, redis, prisma });

  const graceful = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await prisma.$disconnect();
    await redis.quit().catch(() => undefined);
    await pgPool.end();
    process.exit(0);
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);

  try {
    await redis.connect();
  } catch (error) {
    // Fail-soft (T-060): the server still starts; /ready reports Redis down.
    app.log.warn({ err: error }, "Redis unavailable at startup — limiter degraded");
  }

  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  app.log.info({ port: cfg.PORT }, "BalanceVault API listening");
}

main().catch((error) => {
  console.error("Fatal startup failure:", error);
  process.exit(1);
});
