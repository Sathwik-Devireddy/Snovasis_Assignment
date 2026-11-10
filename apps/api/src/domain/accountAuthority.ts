import type { PoolClient } from "pg";
import { canAccount, type AccountGrant, type AccountRef, type Actor, type Permission } from "./permissions.js";

/**
 * In-transaction grant authority (PHASE-05 P5.7b; AUTHZ_MATRIX §D/§D.6, ADR-007).
 *
 * The HTTP-layer authentication (auth plugin) is NOT authority for money:
 * the money command re-reads its facts inside its own PostgreSQL transaction.
 * This module is called from the raw-pg money path (Phase 6 DomainTransactionRunner):
 *
 *   1. `readGrantsForShare(tx, userId, accountIds)` — the money path's grant
 *      segment of the declared lock order: grant rows are read `FOR SHARE`,
 *      ascending id, BEFORE account rows are locked (visited after sessions →
 *      users; ADR-003). `FOR SHARE` conflicts with a concurrent revoke's
 *      `FOR UPDATE` (ADR-007): revocation and the command serialise — the two
 *      legal orders of §D.3.
 *   2. `authorizeInTransaction(...)` — evaluates the pure `canAccount()` policy
 *      against the FOR SHARE grant rows plus the account facts the caller read
 *      under its account row locks (`FOR UPDATE`, ascending id).
 *
 * A refused authorisation makes the money transaction ROLL BACK wholly
 * (nothing stored there); durable refusal records are the caller's separate
 * short audit transaction (REFUSAL_CODES §0, D-9 … Phase 6 wiring).
 */

export type GrantRow = {
  account_id: string | number | bigint;
  permission: string;
};

/**
 * Authoritative grant read, inside the caller's existing pg transaction
 * (`tx` must be a PoolClient with an open transaction). Lock order note:
 * query packs ids in ascending order (`ORDER BY id`) consistent with ADR-003.
 */
export async function readGrantsForShare(
  tx: PoolClient,
  userId: string | number | bigint,
  accountIds: ReadonlyArray<string | number | bigint>,
): Promise<Map<string, Permission>> {
  if (accountIds.length === 0) return new Map();
  // Ascending id read; FOR SHARE serialises against grant revocation (ADR-007).
  const { rows } = await tx.query(
    `SELECT account_id, permission
       FROM account_permissions
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND account_id = ANY($2::bigint[])
        AND permission IN ('VIEW','DEPOSIT','WITHDRAW','TRANSFER','ADJUST')
      ORDER BY id ASC
      FOR SHARE`,
    [userId, accountIds.map((id) => id.toString())],
  );
  const grants = new Map<string, Permission>();
  for (const row of rows) {
    grants.set(row.account_id.toString(), row.permission as Permission);
  }
  return grants;
}

export type AccountAuthority = {
  actorId: string | number | bigint;
  actor: Actor;
  action: "VIEW_ACCOUNT" | "DEPOSIT" | "WITHDRAW" | "TRANSFER";
  accounts: AccountRef[];
};

/**
 * Evaluate authority for one action against `accounts` (already read under the
 * caller's locks) using the FOR SHARE grants read in the same transaction.
 * MULTI-account actions (TRANSFER source→destination) return a single decision:
 * true iff the policy admits the action for every listed account in the
 * caller-declared role of each account (source/destination semantics belong to
 * the money path's D-8 flow — Phase 6 — which passes exactly the accounts it
 * needs and validates destination rules per AUTHZ_MATRIX §A).
 */
export async function authorizeInTransaction(
  tx: PoolClient,
  authority: AccountAuthority,
): Promise<{ allowed: boolean; denialReason?: "ACTOR_INACTIVE" | "POLICY_DENIED"; grants: Map<string, Permission> }> {
  const grants = await readGrantsForShare(
    tx,
    authority.actorId,
    authority.accounts.map((a) => a.id),
  );

  if (authority.actor.status !== "ACTIVE") {
    return { allowed: false, denialReason: "ACTOR_INACTIVE", grants };
  }

  const grantOrNull = (account: AccountRef): AccountGrant | null => {
    const permission = grants.get(account.id.toString());
    return permission ? { permission } : null;
  };

  for (const account of authority.accounts) {
    if (!canAccount(authority.actor, authority.action, account, grantOrNull(account))) {
      return { allowed: false, denialReason: "POLICY_DENIED", grants };
    }
  }
  return { allowed: true, grants };
}
