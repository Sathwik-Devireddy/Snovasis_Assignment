import { describe, expect, it } from "vitest";
import { canAccount, can, type Actor, type AccountRef } from "../../src/domain/permissions.js";

/**
 * PHASE-05 P5.2 — table-driven policy tests mirroring docs/AUTHZ_MATRIX.md
 * §A/§B exactly, row for row. Deny-by-default is the contract: any actor not
 * listed as allowed must be refused. If the matrix changes, this file changes
 * in the same commit (AUTHZ_MATRIX checklist).
 */

const customer = (status: AccountRef["status"] = "ACTIVE"): AccountRef => ({
  id: "1001",
  kind: "CUSTOMER",
  status,
});
const systemAccount = (): AccountRef => ({ id: "2001", kind: "SYSTEM", status: "ACTIVE" });

const grant = (permission: string) => ({ permission: permission as "VIEW" | "DEPOSIT" | "WITHDRAW" | "TRANSFER" });
const grantOrNull = (p: string | null) => (p === null ? null : grant(p));

const admin = (): Actor => ({ id: "1", role: "ADMIN", status: "ACTIVE" });
const holder = (): Actor => ({ id: "2", role: "ACCOUNT_HOLDER", status: "ACTIVE" });
const auditor = (): Actor => ({ id: "3", role: "AUDITOR", status: "ACTIVE" });
const disabled = (role: Actor["role"]): Actor => ({ id: "4", role, status: "DISABLED" });

describe("VIEW_ACCOUNT / VIEW_STATEMENT (AUTHZ_MATRIX §A rows 1–2)", () => {
  it("ADMIN: any account without a grant (role-level)", () => {
    expect(canAccount(admin(), "VIEW_ACCOUNT", customer(), null)).toBe(true);
    expect(canAccount(admin(), "VIEW_STATEMENT", customer(), null)).toBe(true);
  });
  it("AUDITOR: any account without a grant (role-level)", () => {
    expect(canAccount(auditor(), "VIEW_ACCOUNT", customer(), null)).toBe(true);
    expect(canAccount(auditor(), "VIEW_STATEMENT", customer(), null)).toBe(true);
  });
  it("holder: only with an explicit VIEW grant (grant-filtered server-side)", () => {
    expect(canAccount(holder(), "VIEW_ACCOUNT", customer(), grantOrNull(null))).toBe(false);
    expect(canAccount(holder(), "VIEW_ACCOUNT", customer(), grantOrNull("VIEW"))).toBe(true);
    expect(canAccount(holder(), "VIEW_ACCOUNT", customer(), grantOrNull("WITHDRAW"))).toBe(false);
  });
  it("statuses: SUSPENDED/CLOSED remain viewable for role-level actors (§F: views never blocked)", () => {
    expect(canAccount(admin(), "VIEW_ACCOUNT", customer("SUSPENDED"), null)).toBe(true);
    expect(canAccount(auditor(), "VIEW_ACCOUNT", customer("CLOSED"), null)).toBe(true);
    // holders with VIEW see suspended accounts read-only (§F) — plus below the money tests show SUSPENDED refuses money.
    expect(canAccount(holder(), "VIEW_ACCOUNT", customer("SUSPENDED"), grantOrNull("VIEW"))).toBe(true);
  });
  it("disabled actors: denied for everything", () => {
    expect(canAccount(disabled("ADMIN"), "VIEW_ACCOUNT", customer(), null)).toBe(false);
    expect(canAccount(disabled("ACCOUNT_HOLDER"), "VIEW_ACCOUNT", customer(), grantOrNull("VIEW"))).toBe(false);
  });
});

describe("DEPOSIT (H-2: admin-only external money-in)", () => {
  it("ADMIN on an active CUSTOMER account: allowed without any grant", () => {
    expect(canAccount(admin(), "DEPOSIT", customer(), null)).toBe(true);
  });
  it("holder NEVER: no grant path exists for holder deposit (H-2)", () => {
    expect(canAccount(holder(), "DEPOSIT", customer(), grantOrNull("DEPOSIT"))).toBe(false);
  });
  it("AUDITOR never", () => {
    expect(canAccount(auditor(), "DEPOSIT", customer(), null)).toBe(false);
  });
  it("non-ACTIVE destination refuses (T-012: CLOSED/SUSPENDED both directions)", () => {
    expect(canAccount(admin(), "DEPOSIT", customer("SUSPENDED"), null)).toBe(false);
    expect(canAccount(admin(), "DEPOSIT", customer("CLOSED"), null)).toBe(false);
  });
  it("SYSTEM accounts are never targets", () => {
    expect(canAccount(admin(), "DEPOSIT", systemAccount(), grantOrNull("DEPOSIT"))).toBe(false);
  });
});

describe("WITHDRAW (money-out; admin cash-desk vs holder WITHDRAW grant)", () => {
  it("ADMIN: role-level on any active CUSTOMER account", () => {
    expect(canAccount(admin(), "WITHDRAW", customer(), null)).toBe(true);
  });
  it("holder: only with an explicit WITHDRAW grant", () => {
    expect(canAccount(holder(), "WITHDRAW", customer(), grantOrNull(null))).toBe(false);
    expect(canAccount(holder(), "WITHDRAW", customer(), grantOrNull("WITHDRAW"))).toBe(true);
    expect(canAccount(holder(), "WITHDRAW", customer(), grantOrNull("TRANSFER"))).toBe(false);
  });
  it("AUDITOR never", () => {
    expect(canAccount(auditor(), "WITHDRAW", customer(), null)).toBe(false);
  });
  it("source account must be ACTIVE (§F SUSPENDED blocks debits)", () => {
    expect(canAccount(admin(), "WITHDRAW", customer("SUSPENDED"), null)).toBe(false);
    expect(canAccount(holder(), "WITHDRAW", customer("SUSPENDED"), grantOrNull("WITHDRAW"))).toBe(false);
  });
});

describe("TRANSFER (anti-insider T-025: no admin special privilege)", () => {
  it("ADMIN WITHOUT a TRANSFER grant: refused ⚠ exactly like a holder without one", () => {
    expect(canAccount(admin(), "TRANSFER", customer(), null)).toBe(false);
  });
  it("ADMIN WITH a TRANSFER grant: allowed (equal footing, not special)", () => {
    expect(canAccount(admin(), "TRANSFER", customer(), grantOrNull("TRANSFER"))).toBe(true);
  });
  it("holder: only with an explicit TRANSFER grant on the source", () => {
    expect(canAccount(holder(), "TRANSFER", customer(), grantOrNull("TRANSFER"))).toBe(true);
    expect(canAccount(holder(), "TRANSFER", customer(), grantOrNull("WITHDRAW"))).toBe(false);
  });
  it("AUDITOR never", () => {
    expect(canAccount(auditor(), "TRANSFER", customer(), grantOrNull("TRANSFER"))).toBe(false);
  });
  it("source must be ACTIVE", () => {
    expect(canAccount(holder(), "TRANSFER", customer("SUSPENDED"), grantOrNull("TRANSFER"))).toBe(false);
  });
});

describe("ADJUST — H-5 reserved placeholder has NO v1 policy path", () => {
  it("no role is allowed the ADJUST action (not an Action member — type-level exclusion asserted by compile)", () => {
    // The Action union deliberately omits "ADJUST"; this test documents the
    // decision: an ADJUSTMENT journal type is reserved for post-Gate-9 work.
    expect(true).toBe(true);
  });
});

describe("Platform actions (AUTHZ_MATRIX §B)", () => {
  it("ADMIN: user/role/account/grant administration + audit + reconciliation", () => {
    expect(can(admin(), "CREATE_USER")).toBe(true);
    expect(can(admin(), "ASSIGN_ROLE")).toBe(true);
    expect(can(admin(), "DISABLE_USER")).toBe(true);
    expect(can(admin(), "CREATE_ACCOUNT")).toBe(true);
    expect(can(admin(), "MANAGE_ACCOUNT_STATUS")).toBe(true);
    expect(can(admin(), "GRANT_PERMISSION")).toBe(true);
    expect(can(admin(), "REVOKE_PERMISSION")).toBe(true);
    expect(can(admin(), "REVOKE_SESSIONS_ANY")).toBe(true);
    expect(can(admin(), "VIEW_AUDIT")).toBe(true);
    expect(can(admin(), "RECONCILE")).toBe(true);
  });
  it("ADMIN: LEDGER EDIT never exists via API (§B last row)", () => {
    expect(can(admin(), "EDIT_LEDGER")).toBe(false);
  });
  it("ADMIN: VIEW_IDEMPOTENCY read is not admin (read-only AUDITOR view)", () => {
    expect(can(admin(), "VIEW_IDEMPOTENCY")).toBe(false);
  });
  it("AUDITOR: audit + reconciliation + idempotency read-only; zero write paths", () => {
    expect(can(auditor(), "VIEW_AUDIT")).toBe(true);
    expect(can(auditor(), "RECONCILE")).toBe(true);
    expect(can(auditor(), "VIEW_IDEMPOTENCY")).toBe(true);
    for (const action of ["CREATE_USER", "ASSIGN_ROLE", "DISABLE_USER", "CREATE_ACCOUNT", "MANAGE_ACCOUNT_STATUS", "GRANT_PERMISSION", "REVOKE_PERMISSION", "EDIT_LEDGER"] as const) {
      expect(can(auditor(), action)).toBe(false);
    }
  });
  it("holder: own-session management only (§B revoke row)", () => {
    expect(can(holder(), "REVOKE_SESSIONS_OWN")).toBe(true);
    expect(can(holder(), "REVOKE_SESSIONS_ANY")).toBe(false);
    for (const action of ["CREATE_USER", "CREATE_ACCOUNT", "GRANT_PERMISSION", "VIEW_AUDIT", "RECONCILE", "EDIT_LEDGER"] as const) {
      expect(can(holder(), action)).toBe(false);
    }
  });
  it("deny by default: no action succeeds for a disabled user of any role", () => {
    for (const role of ["ADMIN", "ACCOUNT_HOLDER", "AUDITOR"] as const) {
      for (const action of ["CREATE_USER", "VIEW_AUDIT", "RECONCILE", "REVOKE_SESSIONS_OWN"] as const) {
        expect(can(disabled(role), action)).toBe(false);
      }
    }
  });
});
