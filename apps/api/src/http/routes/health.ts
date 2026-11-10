import type { FastifyInstance } from "fastify";

/**
 * `/health` — liveness only (PHASE-04 P4.4). Reveals availability only; no
 * environment details, no DB credentials, no component specifics beyond ok.
 */
export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
  }));
}
