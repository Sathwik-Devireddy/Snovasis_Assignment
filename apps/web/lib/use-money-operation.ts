/**
 * Shared money-operation state machine for the deposit / withdrawal / transfer
 * pages (master-stabilisation 4.3 + Stage C hardening).
 *
 * Rules enforced here (the pages only supply a path and a body):
 *
 *  - The idempotency key is BOUND to its payload. A submission whose payload
 *    is unchanged reuses the original key (the API replays the original
 *    result — no duplicate financial effect); a changed payload starts a NEW
 *    intent with a NEW key (never the same key for a different body, which
 *    the API would answer with 409 KEY_REUSED).
 *  - While the previous outcome is UNKNOWN, a changed payload is REFUSED:
 *    the money may already have moved, so a second intent needs an explicit
 *    "New Intent" from the user.
 *  - A RETRY always re-sends the ORIGINAL path, body and key.
 *  - A malformed 2xx body is an UNKNOWN outcome, never a success and never a
 *    confirmed refusal.
 *  - Parsing/validation happens BEFORE any state transition, so a bad amount
 *    can never leave the page stuck in "sending".
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiPost, classifyMoneyError } from "./api";
import {
  classifyMoneyResponse,
  createIntent,
  decideIntentKey,
  newIdempotencyKey,
  type MoneyIntent,
  type MoneyOutcome,
} from "./money-intent";

export type MoneyOperationState =
  | "idle"
  | "pending"
  | "succeeded"
  | "refused"
  | "invalid"
  | "retry_later"
  | "unknown"
  | "session_expired";

export type MoneyOperation = {
  /** Current UI state. */
  state: MoneyOperationState;
  /** A request is in flight (buttons disabled). */
  pending: boolean;
  /** Outcome of the last attempt (null before the first attempt). */
  outcome: MoneyOutcome | null;
  /** The intent currently bound to the idempotency key (null before the first attempt). */
  intent: MoneyIntent | null;
  /** The key shown in the UI — the one that will be sent. */
  key: string;
  /** Submit a (possibly new) intent. */
  submit: (path: string, body: Record<string, string>) => Promise<void>;
  /** Re-send the ORIGINAL intent (same key, same body). */
  retry: () => Promise<void>;
  /** Explicitly abandon the current intent and start a new one. */
  newIntent: () => void;
};

export function useMoneyOperation(keyPrefix: string): MoneyOperation {
  // SSR-safety (React #418): a key minted DURING render puts a random value
  // into the server-rendered HTML that hydration then replaces with a fresh
  // random value — a guaranteed hydration mismatch. The key therefore starts
  // EMPTY (identical on server and client) and is minted once after mount.
  // Submission never depends on it: the first submit mints its own key via
  // decideIntentKey below.
  const keyRef = useRef<string>("");
  const intentRef = useRef<MoneyIntent | null>(null);
  const outcomeRef = useRef<MoneyOutcome | null>(null);
  const pendingRef = useRef(false);

  const [state, setState] = useState<MoneyOperationState>("idle");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MoneyOutcome | null>(null);
  const [intent, setIntent] = useState<MoneyIntent | null>(null);
  const [key, setKey] = useState<string>("");

  useEffect(() => {
    if (keyRef.current === "") {
      const first = newIdempotencyKey(keyPrefix);
      keyRef.current = first;
      setKey(first);
    }
  }, [keyPrefix]);

  const applyOutcome = useCallback((next: MoneyOutcome) => {
    outcomeRef.current = next;
    setOutcome(next);
    setState(next.kind);
  }, []);

  const send = useCallback(
    async (snapshot: MoneyIntent) => {
      pendingRef.current = true;
      setPending(true);
      setState("pending");
      try {
        const response = await apiPost(snapshot.path, snapshot.body, snapshot.key);
        applyOutcome(classifyMoneyResponse(response));
      } catch (err) {
        const classified = classifyMoneyError(err);
        applyOutcome({
          kind: classified.kind,
          retrySameKey: classified.retrySameKey,
          message: classified.message,
        });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [applyOutcome],
  );

  const submit = useCallback(
    async (path: string, body: Record<string, string>) => {
      if (pendingRef.current) return; // double-submit guard
      const decision = decideIntentKey(intentRef.current, outcomeRef.current, path, body, () =>
        newIdempotencyKey(keyPrefix),
      );
      if (decision.action === "blocked") {
        applyOutcome({
          kind: "unknown",
          retrySameKey: true,
          message: decision.message,
        });
        return;
      }

      const snapshot = createIntent(decision.key, path, body);
      intentRef.current = snapshot;
      setIntent(snapshot);
      setKey(snapshot.key);
      keyRef.current = snapshot.key;
      await send(snapshot);
    },
    [applyOutcome, keyPrefix, send],
  );

  const retry = useCallback(async () => {
    if (pendingRef.current) return;
    const snapshot = intentRef.current;
    if (snapshot === null) return;
    // ALWAYS the original path/body/key — never the live form values.
    await send(snapshot);
  }, [send]);

  const newIntent = useCallback(() => {
    intentRef.current = null;
    outcomeRef.current = null;
    const nextKey = newIdempotencyKey(keyPrefix);
    keyRef.current = nextKey;
    setIntent(null);
    setOutcome(null);
    setKey(nextKey);
    setState("idle");
  }, [keyPrefix]);

  return { state, pending, outcome, intent, key, submit, retry, newIntent };
}
