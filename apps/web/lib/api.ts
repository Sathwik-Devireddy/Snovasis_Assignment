/**
 * API client for BalanceVault frontend (PHASE-10 P11.2).
 *
 * All money-relevant values (amounts, balances, sequence numbers) cross the
 * API as JSON strings (T-049). This client never re-parses them through
 * Number — it passes strings through to the UI unchanged.
 *
 * Errors are normalised to the uniform external envelope:
 *   { error: { code, message } } with an HTTP status code.
 */

type ApiError = { code: string; message: string };

class ApiErrorResponse extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiErrorResponse";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<unknown> {
  const { method = "GET", body, idempotencyKey } = options;
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "include", // send cookies (session) cross-origin to API
    body: body ? JSON.stringify(body) : undefined,
  });

  const bodyText = await res.text();
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    parsed = {};
  }

  if (!res.ok) {
    const err = (parsed as { error?: ApiError })?.error;
    throw new ApiErrorResponse(
      res.status,
      err?.code ?? "INFRA_FAILURE",
      err?.message ?? "Request could not be completed.",
    );
  }

  return parsed;
}

/** GET — read-only endpoints. */
export async function apiGet(path: string): Promise<unknown> {
  return apiRequest(path, { method: "GET" });
}

/** POST — money-movement endpoints (idempotency key required). */
export async function apiPost(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<unknown> {
  return apiRequest(path, { method: "POST", body, idempotencyKey });
}

export { ApiErrorResponse };

/**
 * Money error classification (master-stabilisation 4.3).
 *
 * The backend maps LOCK_TIMEOUT → 503, and the transport can also produce
 * HTTP 408, rate-limit 429, or a network failure — all cases where the
 * financial outcome is NOT known. The money pages must never present an
 * unknown outcome as a confirmed refusal, and a retry of the same intent
 * must always reuse the original idempotency key.
 */
export type MoneyErrorClass =
  | "refused" // confirmed business/authorization refusal (403/404/409)
  | "session_expired" // 401 — sign in again; nothing was processed
  | "invalid" // 400 — permanent validation failure; nothing was processed
  | "retry_later" // 429 — rate limited; nothing was processed
  | "unknown"; // 408 / 503 LOCK_TIMEOUT / network / other 5xx — outcome NOT known

export type ClassifiedMoneyError = {
  kind: MoneyErrorClass;
  /** Outcome not known or not yet processed — retrying with the SAME key is safe. */
  retrySameKey: boolean;
  /** User-facing message. Never claims a definite failure when the outcome is unknown. */
  message: string;
  code: string;
};

export function classifyMoneyError(err: unknown): ClassifiedMoneyError {
  if (err instanceof ApiErrorResponse) {
    const { statusCode, code, message } = err;
    if (statusCode === 503 && code === "LOCK_TIMEOUT") {
      return {
        kind: "unknown",
        retrySameKey: true,
        code,
        message:
          "Lock timeout: your request may or may not have been processed. Retry with the same idempotency key to check.",
      };
    }
    if (statusCode === 408) {
      return {
        kind: "unknown",
        retrySameKey: true,
        code,
        message:
          "Request timed out: the outcome is not known. Retry with the same idempotency key to check.",
      };
    }
    if (statusCode === 401) {
      return {
        kind: "session_expired",
        retrySameKey: false,
        code,
        message: "Your session has expired. Please sign in again.",
      };
    }
    if (statusCode === 400) {
      return {
        kind: "invalid",
        retrySameKey: false,
        code,
        message: `Invalid request: ${message}`,
      };
    }
    if (statusCode === 429) {
      return {
        kind: "retry_later",
        retrySameKey: true,
        code,
        message:
          "Too many requests: nothing was processed. Wait a moment, then retry with the same idempotency key.",
      };
    }
    if (statusCode >= 500) {
      return {
        kind: "unknown",
        retrySameKey: true,
        code,
        message:
          "Server error: the outcome is not known. Retry with the same idempotency key to check.",
      };
    }
    return {
      kind: "refused",
      retrySameKey: false,
      code,
      message: `Refused: ${code}`,
    };
  }
  // Not an envelope (e.g. fetch TypeError on network failure): the request
  // may never have reached the API — the outcome is unknown.
  return {
    kind: "unknown",
    retrySameKey: true,
    code: "NETWORK_ERROR",
    message:
      "Network error: the outcome is not known. Retry with the same idempotency key to check.",
  };
}
