import { z } from "zod";

/**
 * Fail-fast environment configuration (PHASE-04 P4.2).
 *
 * Separation of connection roles is normative (ADR-005):
 *   DATABASE_URL           — runtime role `ledgerline_app` (raw pg money path AND Prisma routine path)
 *   DATABASE_URL_OWNER     — role `ledgerline_owner`, migrations/DDL only
 *   DATABASE_URL_BOOTSTRAP — bootstrap superuser, used only by migration 0001
 * A boot-time guard asserts the app is not accidentally pointed at the
 * owner/credentials (ADR-005 risks: "runs the app with the owner credentials").
 */

const PgUrl = z
  .string()
  .url()
  .regex(/^postgres(?:ql)?:\/\//, "must be a postgresql:// URL");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

    /** Runtime connection: raw pg (money path) and Prisma (routine path) — same DB, same role. */
    DATABASE_URL: PgUrl,
    /** Owner connection: migrations and DDL only; the server runtime never uses it. */
    DATABASE_URL_OWNER: PgUrl,
    /** Bootstrap superuser: role provisioning only (migration 0001). */
    DATABASE_URL_BOOTSTRAP: PgUrl,

    /** Redis: rate limiting ONLY — never financial/ledger/idempotency state (THREATS T-060). */
    REDIS_URL: z.string().url().regex(/^rediss?:\/\//, "must be a redis:// URL"),

    /** Session lifetime (ADR-006): opaque cookie token TTL in seconds. */
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(30 * 24 * 60 * 60).default(43_200),
    /**
     * `Secure` cookie flag (ADR-006 risk row): always true in production
     * (enforced below — the server refuses to start otherwise); false is
     * permitted only for plain-HTTP localhost development, that exemption is
     * the documented ADR-006 exception.
     */
    COOKIE_SECURE: z.enum(["true", "false"]).default("false"),

    /** Rate limits (fixed window per identity; Redis-backed, fail-soft — T-060). */
    RATE_LIMIT_REGISTER_LIMIT: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REGISTER_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
    RATE_LIMIT_LOGIN_LIMIT: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    /** Money endpoints (Phase 6 reuse the same limiter; configured now). */
    RATE_LIMIT_MONEY_LIMIT: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MONEY_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  })
  .superRefine((env, ctx) => {
    const runtimeUser = postgresUser(env.DATABASE_URL);
    const ownerUser = postgresUser(env.DATABASE_URL_OWNER);
    if (runtimeUser === ownerUser) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "DATABASE_URL and DATABASE_URL_OWNER must use different roles (ledgerline_app vs ledgerline_owner, ADR-005) — running the app as the migration role is forbidden.",
      });
    }
    if (env.NODE_ENV === "production" && env.COOKIE_SECURE !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "COOKIE_SECURE must be 'true' in production (ADR-006; Secure cookies over HTTPS).",
      });
    }
  });

/** Extract the userinfo user part of a postgres URL without exposing secrets. */
function postgresUser(url: string): string {
  try {
    const u = new URL(url);
    return u.username;
  } catch {
    return "";
  }
}

export type Config = z.infer<typeof envSchema>;

/** Parse process env once, throw on any problem (fail fast, no partial start). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuration invalid — refusing to start. ${problems}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Shared parsed config (module-load parse = fail fast at require time). */
export function config(): Config {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}
