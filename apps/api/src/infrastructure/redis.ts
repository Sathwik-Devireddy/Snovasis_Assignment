import type Redis from "ioredis";
import { config } from "../config.js";

/**
 * Redis client — rate limiting ONLY (PHASE-04 P4.2+ / BalanceVault expansion).
 * Normative boundary (ARCHITECTURE.md BalanceVault expansion; THREATS T-060):
 * Redis never holds balances, ledger, idempotency or audit-authority state.
 * An outage can only degrade limiting (fail-soft); the database-side cap
 * (T-042) is the second line of defence.
 */

export interface RedisLike {
  ping(): Promise<string>;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<string>;
}

export function createRedisClient(spec: { url: string; lazyConnect?: boolean }): RedisLike {
  // Lazy require: ioredis is CJS and the connection is built lazily.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: RedisCtor } = require("ioredis") as { default: typeof Redis };
  return new RedisCtor(spec.url, {
    lazyConnect: spec.lazyConnect ?? true,
    maxRetriesPerRequest: 0, // fail-soft: never hang requests behind limiter state
    connectTimeout: 2_000,
    enableOfflineQueue: true,
  }) as unknown as RedisLike;
}

export function defaultRedisOptions(): { url: string; lazyConnect: boolean } {
  return { url: config().REDIS_URL, lazyConnect: true };
}
