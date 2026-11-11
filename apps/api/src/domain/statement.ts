/**
 * Account statement (PHASE-10 P10.1; REFUSAL_CODES §5, decision 9).
 *
 * One merged `timeline` from two pre-ordered category lists:
 *   - `category: "event"`  — ledger postings AND locked business refusals
 *     (rows carrying an `account_event_seq`); ordered STRICTLY by the shared
 *     per-account counter, never by any clock.
 *   - `category: "attempt"` — refused attempts WITHOUT an event position
 *     (pre-lock business refusals, authorisation refusals); ordered by
 *     `(occurred_at, global_seq)`; `event_position: null` permanently.
 *   - Merge: deterministic head-first pass on `occurred_at` (earlier first;
 *     exact tie → event first), consuming each list strictly in order so no
 *     merge can ever reorder rows within a category. FAILED rows are excluded
 *     by the queries (never statement-visible) and SUCCEEDED attempt rows are
 *     audit-view content that would duplicate postings.
 *
 * Keyset pagination: the cursor carries the last-emitted position of EACH
 * category (`{ e: seq, a: [occurred_at, global_seq] }`), so a page never
 * duplicates or skips rows even when one category is exhausted mid-page.
 * Money and sequence values cross the API as strings (BigInt-safe, T-049).
 */

export type RawEventRow = {
  /** `account_event_seq` — shared counter value (string from pg). */
  seq: string;
  rowKind: "posting" | "refusal";
  /** Journal type for postings, "REFUSAL" for locked refusals. */
  type: string;
  direction: string | null;
  amountMinor: string | null;
  /** Stored `balance_after_minor` (postings) or measured `balance_at_attempt_minor` (locked refusals). */
  balance: string | null;
  occurredAt: Date;
  initiatedBy: string | null;
  journalId: string | null;
  initiatorEmail: string | null;
  /** Granular internal reason code for locked refusals (A8: holders see it). */
  reasonCode: string | null;
};

export type RawAttemptRow = {
  globalSeq: string;
  occurredAt: Date;
  reasonCode: string;
  operation: string;
  initiatedBy: string | null;
  initiatorEmail: string | null;
};

export type TimelineRow = {
  category: "event" | "attempt";
  eventPosition: string | null;
  type: string;
  direction: string | null;
  amountMinor: string | null;
  balanceMinor: string | null;
  occurredAt: string;
  initiator: { userId: string; displayName: string | null } | null;
  journalTransactionId: string | null;
  status: "POSTED" | "REFUSED";
  reasonCode: string | null;
};

export type StatementCursor = {
  /** Last emitted event `account_event_seq` (string or null). */
  e: string | null;
  /** Last emitted attempt `(occurred_at, global_seq)` (ISO string or null). */
  a: [string, string] | null;
};

/**
 * Initiator display name. The `users` table has no display-name column; the
 * email local-part is used and is the documented limitation (full emails are
 * never rendered — they are login identifiers, not public profile data).
 */
export function initiatorDisplayName(email: string | null): string | null {
  if (email === null || email === undefined) return null;
  const local = email.split("@")[0] ?? "";
  return local.length > 0 ? local : null;
}

function eventRow(raw: RawEventRow): TimelineRow {
  return {
    category: "event",
    eventPosition: raw.seq,
    type: raw.type,
    direction: raw.direction,
    amountMinor: raw.amountMinor,
    balanceMinor: raw.balance,
    occurredAt: raw.occurredAt.toISOString(),
    initiator:
      raw.initiatedBy === null
        ? null
        : { userId: raw.initiatedBy, displayName: initiatorDisplayName(raw.initiatorEmail) },
    journalTransactionId: raw.journalId,
    status: raw.rowKind === "posting" ? "POSTED" : "REFUSED",
    reasonCode: raw.rowKind === "refusal" ? raw.reasonCode : null,
  };
}

function attemptRow(raw: RawAttemptRow): TimelineRow {
  return {
    category: "attempt",
    eventPosition: null,
    type: "REFUSAL",
    direction: null,
    amountMinor: null,
    // Unsequenced rows never claim a balance (REFUSAL_CODES §5 tier 2).
    balanceMinor: null,
    occurredAt: raw.occurredAt.toISOString(),
    initiator:
      raw.initiatedBy === null
        ? null
        : { userId: raw.initiatedBy, displayName: initiatorDisplayName(raw.initiatorEmail) },
    journalTransactionId: null,
    status: "REFUSED",
    reasonCode: raw.reasonCode,
  };
}

export type MergeResult = {
  rows: TimelineRow[];
  /** Last EMITTED row per category (cursor continuation points). */
  lastEvent: RawEventRow | null;
  lastAttempt: RawAttemptRow | null;
  /** True when at least one category still has fetched-but-unconsumed rows. */
  hasMore: boolean;
};

/**
 * Head-first merge. `occurred_at` is only the interleave signal; the relative
 * order WITHIN each category always follows that category's own discipline
 * (event rows: `account_event_seq`; attempt rows: `(occurred_at, global_seq)`).
 */
export function mergeTimeline(events: RawEventRow[], attempts: RawAttemptRow[], limit: number): MergeResult {
  const rows: TimelineRow[] = [];
  let i = 0;
  let j = 0;
  while (rows.length < limit && (i < events.length || j < attempts.length)) {
    const ev = events[i];
    const at = attempts[j];
    // Exact tie → event first (spec); comparisons use epoch millis so clock
    // format differences cannot leak into ordering.
    const takeEvent = at === undefined ? true : ev === undefined ? false : ev.occurredAt.getTime() <= at.occurredAt.getTime();
    if (takeEvent) {
      rows.push(eventRow(ev!));
      i += 1;
    } else {
      rows.push(attemptRow(at!));
      j += 1;
    }
  }
  return {
    rows,
    lastEvent: i > 0 ? events[i - 1]! : null,
    lastAttempt: j > 0 ? attempts[j - 1]! : null,
    hasMore: i < events.length || j < attempts.length,
  };
}

/** Opaque keyset cursor: base64url(JSON) — never parsed by clients. */
export function encodeCursor(cursor: StatementCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): StatementCursor {
  if (raw === undefined || raw === "") return { e: null, a: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor malformed");
  }
  const c = parsed as StatementCursor;
  const valid =
    typeof c === "object" &&
    c !== null &&
    (c.e === null || typeof c.e === "string") &&
    (c.a === null ||
      (Array.isArray(c.a) && c.a.length === 2 && typeof c.a[0] === "string" && typeof c.a[1] === "string"));
  if (!valid) throw new Error("cursor malformed");
  if (c.e !== null && !/^\d{1,19}$/.test(c.e)) throw new Error("cursor malformed");
  if (c.a !== null && (Number.isNaN(Date.parse(c.a[0])) || !/^\d{1,19}$/.test(c.a[1]))) {
    throw new Error("cursor malformed");
  }
  return { e: c.e, a: c.a };
}
