import { describe, it, expect } from "vitest";

import { MoneyParseError, parseAmountToPaise } from "./money";

/**
 * PHASE-11 P11.5 — string parsing tests, no floats.
 *
 * The `0.1 + 0.2` case is the classic IEEE-754 trap: in JavaScript,
 * 0.1 + 0.2 === 0.30000000000000004. Parsing "0.1" and "0.2" into integer
 * paise strings and adding them as BigInt must be exactly 30.
 */
describe("parseAmountToPaise (PHASE-11 P11.5)", () => {
  it("0.1 + 0.2 is exactly 30 paise (no float drift)", () => {
    const a = BigInt(parseAmountToPaise("0.1"));
    const b = BigInt(parseAmountToPaise("0.2"));
    expect(a + b).toBe(30n);
  });

  it("parses whole rupees", () => {
    expect(parseAmountToPaise("1")).toBe("100");
    expect(parseAmountToPaise("50")).toBe("5000");
    expect(parseAmountToPaise("0")).toBe("0");
  });

  it("parses explicit two-decimal amounts", () => {
    expect(parseAmountToPaise("50.00")).toBe("5000");
    expect(parseAmountToPaise("0.01")).toBe("1");
    expect(parseAmountToPaise("0.10")).toBe("10");
    expect(parseAmountToPaise("10.25")).toBe("1025");
  });

  it("pads a single decimal digit (10.5 → 1050, never 10.5 rupees float)", () => {
    expect(parseAmountToPaise("10.5")).toBe("1050");
    expect(parseAmountToPaise("0.5")).toBe("50");
  });

  it("keeps exact precision beyond the 2^53 float boundary", () => {
    // 9007199254740993 cannot be represented as a Number; string/BigInt
    // parsing must still be exact.
    expect(parseAmountToPaise("9007199254740993.99")).toBe("900719925474099399");
    expect(parseAmountToPaise("0.1")).toBe("10");
  });

  it("surrounding whitespace is tolerated", () => {
    expect(parseAmountToPaise("  50.00 ")).toBe("5000");
  });

  it("rejects amounts with more than 2 decimals (no silent rounding)", () => {
    expect(() => parseAmountToPaise("10.999")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("0.123")).toThrow(MoneyParseError);
  });

  it("rejects negative amounts", () => {
    expect(() => parseAmountToPaise("-5")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("-0.01")).toThrow(MoneyParseError);
  });

  it("rejects non-numeric and malformed input", () => {
    expect(() => parseAmountToPaise("abc")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("1.2.3")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("1e5")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise(".5")).toThrow(MoneyParseError);
    expect(() => parseAmountToPaise("5.")).toThrow(MoneyParseError);
  });

  it("rejects + sign prefix (server grammar parity)", () => {
    expect(() => parseAmountToPaise("+5.00")).toThrow(MoneyParseError);
  });
});
