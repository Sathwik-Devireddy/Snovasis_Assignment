import { describe, it, expect } from "vitest";
import {
  classifyMoneyResponse,
  createIntent,
  decideIntentKey,
  intentMatches,
  newIdempotencyKey,
} from "./money-intent";

/**
 * Money-intent model (master-stabilisation 4.3 + Stage C).
 *
 * The regression these tests pin: the retry path used to rebuild the request
 * body from the LIVE form fields. After an unknown outcome the user could edit
 * the amount and press "Retry (same key)" — the API would then see a DIFFERENT
 * payload under the SAME key, answer 409 KEY_REUSED, and the UI would show a
 * "confirmed refusal" for a transaction that may already have committed
 * (inviting a duplicate financial effect).
 */

describe("idempotency key generation", () => {
  it("prefixes a unique key", () => {
    const a = newIdempotencyKey("dep");
    const b = newIdempotencyKey("dep");
    expect(a.startsWith("dep_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("never returns an empty key (the API rejects a missing Idempotency-Key)", () => {
    expect(newIdempotencyKey("wd").length).toBeGreaterThan(3);
  });
});

describe("intent snapshots", () => {
  const body = { amountMinor: "10000", currencyCode: "INR" };

  it("detects the very same payload", () => {
    const intent = createIntent("dep_1", "/accounts/1/deposits", body);
    expect(intentMatches(intent, "/accounts/1/deposits", { ...body })).toBe(true);
  });

  it("detects a changed payload (must never reuse the key)", () => {
    const intent = createIntent("dep_1", "/accounts/1/deposits", body);
    expect(intentMatches(intent, "/accounts/1/deposits", { ...body, amountMinor: "20000" })).toBe(
      false,
    );
    expect(intentMatches(intent, "/accounts/2/deposits", { ...body })).toBe(false);
    expect(intentMatches(intent, "/accounts/1/deposits", { amountMinor: "10000" })).toBe(false);
  });

  it("is a copy — later mutation of the caller's body cannot change the intent", () => {
    const mutable = { ...body };
    const intent = createIntent("dep_1", "/accounts/1/deposits", mutable);
    mutable.amountMinor = "99999";
    expect(intent.body.amountMinor).toBe("10000");
  });

  it("treats a null intent as never matching", () => {
    expect(intentMatches(null, "/accounts/1/deposits", body)).toBe(false);
  });
});

describe("idempotency key decision per submission", () => {
  const body = { amountMinor: "10000", currencyCode: "INR" };
  const changed = { amountMinor: "20000", currencyCode: "INR" };
  const mint = () => "dep_NEW";

  it("mints a key for the very first intent", () => {
    const decision = decideIntentKey(null, null, "/accounts/1/deposits", body, mint);
    expect(decision).toEqual({ action: "send", key: "dep_NEW" });
  });

  it("REUSES the original key for the same payload (double click cannot double-spend)", () => {
    const previous = createIntent("dep_OLD", "/accounts/1/deposits", body);
    const decision = decideIntentKey(
      previous,
      { kind: "succeeded", retrySameKey: false, message: "" },
      "/accounts/1/deposits",
      { ...body },
      mint,
    );
    expect(decision).toEqual({ action: "send", key: "dep_OLD" });
  });

  it("mints a NEW key for a changed payload after a known outcome", () => {
    const previous = createIntent("dep_OLD", "/accounts/1/deposits", body);
    for (const outcome of [
      { kind: "succeeded", retrySameKey: false, message: "" },
      { kind: "refused", retrySameKey: false, message: "" },
    ] as const) {
      const decision = decideIntentKey(previous, outcome, "/accounts/1/deposits", changed, mint);
      expect(decision).toEqual({ action: "send", key: "dep_NEW" });
    }
  });

  it("BLOCKS a changed payload while the previous outcome is unknown", () => {
    const previous = createIntent("dep_OLD", "/accounts/1/deposits", body);
    const decision = decideIntentKey(
      previous,
      { kind: "unknown", retrySameKey: true, message: "" },
      "/accounts/1/deposits",
      changed,
      mint,
    );
    expect(decision.action).toBe("blocked");
  });

  it("allows the SAME payload again while the outcome is unknown (a safe retry)", () => {
    const previous = createIntent("dep_OLD", "/accounts/1/deposits", body);
    const decision = decideIntentKey(
      previous,
      { kind: "unknown", retrySameKey: true, message: "" },
      "/accounts/1/deposits",
      { ...body },
      mint,
    );
    expect(decision).toEqual({ action: "send", key: "dep_OLD" });
  });
});

describe("2xx response classification", () => {
  it("recognises a confirmed success", () => {
    const outcome = classifyMoneyResponse({
      status: "SUCCEEDED",
      journalTransactionId: "42",
      replayed: false,
    });
    expect(outcome.kind).toBe("succeeded");
    expect(outcome.message).toContain("42");
  });

  it("marks a replayed success as succeeded", () => {
    const outcome = classifyMoneyResponse({
      status: "SUCCEEDED",
      journalTransactionId: "42",
      replayed: true,
    });
    expect(outcome.kind).toBe("succeeded");
    expect(outcome.message).toContain("replayed");
  });

  it("treats a documented non-success status as a CONFIRMED refusal", () => {
    const outcome = classifyMoneyResponse({ status: "REFUSED", reason: "INSUFFICIENT_FUNDS" });
    expect(outcome.kind).toBe("refused");
    expect(outcome.retrySameKey).toBe(false);
  });

  it("treats a malformed 2xx body as UNKNOWN (never a success, never a refusal)", () => {
    for (const body of [{}, { status: 42 }, null, "ok", undefined]) {
      const outcome = classifyMoneyResponse(body);
      expect(outcome.kind).toBe("unknown");
      expect(outcome.retrySameKey).toBe(true);
    }
  });
});
