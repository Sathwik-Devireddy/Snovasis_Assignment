import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "postgresql://ledgerline_app:pw@localhost:15432/balancevault",
  DATABASE_URL_OWNER: "postgresql://ledgerline_owner:pw@localhost:15432/balancevault",
  DATABASE_URL_BOOTSTRAP: "postgresql://balancevault_bootstrap:pw@localhost:15432/balancevault",
  REDIS_URL: "redis://localhost:16379",
};

describe("config (fail-fast)", () => {
  it("accepts a fully separated, correct environment", () => {
    expect(loadConfig(base)).toBeTruthy();
  });

  it("applies defaults for PORT/NODE_ENV/LOG_LEVEL", () => {
    const cfg = loadConfig(base);
    expect(cfg.PORT).toBe(4000);
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.LOG_LEVEL).toBe("info");
  });

  it("refuses the app running as the owner role (ADR-005)", () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL_OWNER: base.DATABASE_URL, // same role both URLs — forbidden
      }),
    ).toThrow(/different roles/);
  });

  it("refuses a missing required variable", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined as unknown as string })).toThrow();
  });

  it("refuses a non-postgres URL", () => {
    expect(() =>
      loadConfig({ ...base, DATABASE_URL: "mysql://ledgerline_app:pw@localhost:15432/x" }),
    ).toThrow();
  });

  it("refuses a non-redis REDIS_URL", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "http://localhost:16379" })).toThrow();
  });
});
