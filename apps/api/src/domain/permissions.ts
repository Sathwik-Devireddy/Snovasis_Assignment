/**
 * Pure authorisation policy (PHASE-05 P5.2; AUTHZ_MATRIX Rev 4).
 *
 * `can()` is a deny-by-default pure function mirroring AUTHZ_MATRIX §A/§B
 * table-for-table. It decides NOTHING at runtime alone: every protected route
 * additionally re-derives role + grants from the database (P5.4; the money
 * path re-reads them FOR SHARE inside its transaction — AUTHZ_MATRIX §D),
 * and every refusal is audited. This module is the single policy truth so the
 * policy and its tests change in the same commit (AUTHZ_MATRIX checklist).
 */

export type Role = "ADMIN" | "ACCOUNT_HOLDER" | "AUDITOR";

/** Grant vocabulary of `account_permissions.permission` (schema enum). */
export type Permission = "VIEW" | "DEPOSIT" | "WITHDRAW" | "TRANSFER" | "ADJUST";

export type AccountRef = {
  /** Existence is proven by the caller (DB row) — policy never invents accounts. */
  id: string | number;
  /** Only CUSTOMER accounts are ever targets of money operations (AUTHZ_MATRIX legend). */
  kind: "CUSTOMER" | "SYSTEM";
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
};

export type Actor = {
  id: string;
  role: Role;
  status: "ACTIVE" | "DISABLED";
};

export type Action =
  | "VIEW_ACCOUNT"
  | "VIEW_STATEMENT"
  | "DEPOSIT"
  | "WITHDRAW"
  | "TRANSFER"
  // Administration (§B)
  | "CREATE_USER"
  | "ASSIGN_ROLE" // ⚠ never own role change — enforced by the caller, not here
  | "DISABLE_USER"
  | "CREATE_ACCOUNT"
  | "MANAGE_ACCOUNT_STATUS"
  | "GRANT_PERMISSION" // ⚠ never to/from self — caller-enforced (AUTH-004)
  | "REVOKE_PERMISSION"
  | "REVOKE_SESSIONS_ANY"
  | "REVOKE_SESSIONS_OWN"
  | "VIEW_AUDIT"
  | "RECONCILE"
  | "VIEW_IDEMPOTENCY"
  // Zero write paths for the ledger via the API (§B last row)
  | "EDIT_LEDGER";

export type AccountGrant = { permission: Permission };

const ADMIN_ACTIONS: readonly Action[] = [
  "CREATE_USER",
  "ASSIGN_ROLE",
  "DISABLE_USER",
  "CREATE_ACCOUNT",
  "MANAGE_ACCOUNT_STATUS",
  "GRANT_PERMISSION",
  "REVOKE_PERMISSION",
  "REVOKE_SESSIONS_ANY",
  "VIEW_AUDIT",
  "RECONCILE",
];

const AUDITOR_ACTIONS: readonly Action[] = ["VIEW_AUDIT", "RECONCILE", "VIEW_IDEMPOTENCY"];

/**
 * Account-scoped policy (AUTHZ_MATRIX §A). server-enforced; `grant` is the
 * specific active account_permissions row the actor holds on this account.
 */
export function canAccount(
  actor: Actor,
  action: "VIEW_ACCOUNT" | "VIEW_STATEMENT" | "DEPOSIT" | "WITHDRAW" | "TRANSFER",
  account: AccountRef,
  grant: AccountGrant | null,
): boolean {
  if (actor.status !== "ACTIVE") return false;
  if (account.kind !== "CUSTOMER") return false; // SYSTEM accounts are never targets

  const needsGrant = (grant: AccountGrant | null, permission: Permission): grant is AccountGrant =>
    grant !== null && actor.status === "ACTIVE" && grant.permission === permission;

  switch (action) {
    case "VIEW_ACCOUNT":
    case "VIEW_STATEMENT":
      // ADMIN/AUDITOR: role-level visibility (any account; suspended included);
      // HOLDER: only VIEW-granted accounts.
      return (
        actor.role === "ADMIN" ||
        actor.role === "AUDITOR" ||
        (actor.role === "ACCOUNT_HOLDER" && needsGrant(grant, "VIEW"))
      );
    case "DEPOSIT":
      // H-2: admin-only external money-in; no holder grant path ever exists.
      return actor.role === "ADMIN" && account.status === "ACTIVE";
    case "WITHDRAW":
      // Money-out requires the source account active; ADMIN is role-level,
      // HOLDER needs an explicit WITHDRAW grant.
      return (
        account.status === "ACTIVE" &&
        (actor.role === "ADMIN" ||
          (actor.role === "ACCOUNT_HOLDER" && needsGrant(grant, "WITHDRAW")))
      );
    case "TRANSFER":
      // ⚠ Anti-insider (T-025): ADMIN gets NO special transfer privilege —
      // both ADMIN and HOLDER need the explicit TRANSFER grant.
      return (
        account.status === "ACTIVE" &&
        (actor.role === "ADMIN" || actor.role === "ACCOUNT_HOLDER") &&
        needsGrant(grant, "TRANSFER")
      );
  }
}

/** Platform/administration policy (AUTHZ_MATRIX §B). */
export function can(actor: Actor, action: Action): boolean {
  if (actor.status !== "ACTIVE") return false;
  switch (actor.role) {
    case "ADMIN":
      return ADMIN_ACTIONS.includes(action) || action === "VIEW_ACCOUNT";
    case "AUDITOR":
      return AUDITOR_ACTIONS.includes(action);
    case "ACCOUNT_HOLDER":
      return action === "REVOKE_SESSIONS_OWN";
  }
}
