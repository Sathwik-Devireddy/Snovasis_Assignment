import type { FastifyInstance } from "fastify";

/**
 * `/health` — liveness only (PHASE-04 P4.4). Reveals availability only; no
 * environment details, no DB credentials, no component specifics beyond ok.
 * Readiness (PostgreSQL + Redis, degraded-mode reporting) lives in
 * `routes/ready.ts` (`/ready`, HEALTH-001).
 */
export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
  }));
}
