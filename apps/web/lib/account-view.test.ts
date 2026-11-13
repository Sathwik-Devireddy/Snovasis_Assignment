import { describe, it, expect } from "vitest";

import { balanceLabel, parseAccountList, parseAccountRecord } from "./account-view";

/**
 * Account contract tests (Phase-2 frontend/backend contract audit).
 *
 * The API's serializeAccount (apps/api/src/http/routes/accounts.ts) emits
 * camelCase with money as JSON strings (T-049). The accounts pages previously
 * declared snake_case fields, so every balance silently rendered "—" while the
 * account actually held money. These tests pin the contract with a fixture
 * captured verbatim from GET /accounts.
 */

// Verbatim element shape from GET /accounts (live verification).
const API_ACCOUNT = {
  id: "4",
  accountNumber: "acc_0076f16ed186",
  label: "holder A",
  currencyCode: "INR",
  kind: "CUSTOMER",
  status: "ACTIVE",
  balanceMinor: "87000",
  eventLastSeq: "3",
};

describe("parseAccountList (camelCase contract)", () => {
  it("parses the real GET /accounts envelope and preserves string balances", () => {
    const list = parseAccountList({ accounts: [API_ACCOUNT] });
    expect(list).not.toBeNull();
    expect(list).toHaveLength(1);
    expect(list![0]!.balanceMinor).toBe("87000");
    expect(list![0]!.accountNumber).toBe("acc_0076f16ed186");
    expect(balanceLabel(list![0]!)).toBe("87000");
  });

  it("accepts an empty list (authorized user with no visible accounts)", () => {
    expect(parseAccountList({ accounts: [] })).toEqual([]);
  });

  it("REJECTS a snake_case payload instead of silently blanking balances", () => {
    // The old page bug: snake_case fields read as undefined → balance "—".
    const snake = { accounts: [{ ...API_ACCOUNT, accountNumber: undefined, balanceMinor: undefined, currencyCode: undefined }] as unknown };
    // Simulate the exact snake_case JSON the old type claimed:
    const snakeBody = {
      accounts: [
        {
          id: "4",
          account_number: "acc_0076f16ed186",
          label: "holder A",
          currency_code: "INR",
          kind: "CUSTOMER",
          status: "ACTIVE",
          balance_minor: "87000",
          event_last_seq: "3",
        },
      ],
    };
    expect(parseAccountList(snake as unknown)).toBeNull();
    expect(parseAccountList(snakeBody)).toBeNull();
  });

  it("rejects a malformed envelope", () => {
    expect(parseAccountList(null)).toBeNull();
    expect(parseAccountList({})).toBeNull();
    expect(parseAccountList({ accounts: "no" })).toBeNull();
    expect(parseAccountList({ accounts: [42] })).toBeNull();
  });
});

describe("parseAccountRecord", () => {
  it("parses a full account object", () => {
    const record = parseAccountRecord(API_ACCOUNT);
    expect(record).not.toBeNull();
    expect(record!.eventLastSeq).toBe("3");
  });

  it("accepts null balance and null event counter (SYSTEM accounts)", () => {
    const record = parseAccountRecord({
      ...API_ACCOUNT,
      balanceMinor: null,
      eventLastSeq: null,
      kind: "SYSTEM",
    });
    expect(record!.balanceMinor).toBeNull();
    expect(balanceLabel(record!)).toBe("—");
  });

  it("rejects missing required fields and non-string balances", () => {
    expect(parseAccountRecord(null)).toBeNull();
    expect(parseAccountRecord({ ...API_ACCOUNT, id: 4 })).toBeNull();
    expect(parseAccountRecord({ ...API_ACCOUNT, balanceMinor: 87000 })).toBeNull();
    expect(parseAccountRecord({ ...API_ACCOUNT, status: undefined })).toBeNull();
  });
});
