/**
 * Account contract views (Phase-2 frontend/backend contract audit).
 *
 * The API serialises accounts in camelCase — `serializeAccount` in
 * apps/api/src/http/routes/accounts.ts emits `accountNumber`, `balanceMinor`,
 * `eventLastSeq`, with money values as JSON strings (T-049). The accounts
 * pages previously declared snake_case fields, so every lookup came back
 * `undefined` and every balance silently rendered "—" even when the account
 * held money.
 *
 * The parsers here pin that contract at runtime: a payload that does not
 * match the camelCase envelope is rejected loudly (the page shows an error
 * instead of a blank column) and the unit tests fail if the API's shape ever
 * drifts.
 */

export type AccountRecord = {
  id: string;
  accountNumber: string;
  label: string;
  currencyCode: string;
  kind: string;
  status: string;
  balanceMinor: string | null;
  eventLastSeq: string | null;
};

/** Human label for an account balance: the string as received, or "—". */
export function balanceLabel(account: Pick<AccountRecord, "balanceMinor">): string {
  return account.balanceMinor ?? "—";
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validate one account object against the API contract. Returns null when the
 * shape does not match (wrong casing, missing fields, wrong types).
 */
export function parseAccountRecord(raw: unknown): AccountRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (typeof r.accountNumber !== "string") return null;
  if (typeof r.label !== "string") return null;
  if (typeof r.currencyCode !== "string") return null;
  if (typeof r.kind !== "string") return null;
  if (typeof r.status !== "string") return null;
  const balance = asStringOrNull(r.balanceMinor);
  const seq = asStringOrNull(r.eventLastSeq);
  if (r.balanceMinor !== null && balance === null) return null;
  if (r.eventLastSeq !== null && seq === null) return null;
  return {
    id: r.id,
    accountNumber: r.accountNumber,
    label: r.label,
    currencyCode: r.currencyCode,
    kind: r.kind,
    status: r.status,
    balanceMinor: balance,
    eventLastSeq: seq,
  };
}

/**
 * Validate the GET /accounts envelope `{ accounts: [...] }`. Returns null when
 * the envelope or any element fails the contract (never a silent partial list).
 */
export function parseAccountList(body: unknown): AccountRecord[] | null {
  if (typeof body !== "object" || body === null) return null;
  const list = (body as { accounts?: unknown }).accounts;
  if (!Array.isArray(list)) return null;
  const parsed: AccountRecord[] = [];
  for (const item of list) {
    const record = parseAccountRecord(item);
    if (record === null) return null;
    parsed.push(record);
  }
  return parsed;
}
