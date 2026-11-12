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

export type { ApiErrorResponse };
