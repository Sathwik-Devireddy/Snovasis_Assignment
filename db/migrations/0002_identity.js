"use strict";

/**
 * Migration 0002 — identity, sessions, per-account grants, audit (PHASE-05 P5.1).
 *
 * Mirrors `ledgerline-repo-kit/docs/schema-draft.sql` verbatim: constraint,
 * index and table names are part of the design contract (ADR-005). Runs AS
 * `ledgerline_owner`; all tables become owner-owned, and the runtime role
 * `ledgerline_app` receives exactly the planned grants (ADR-005 item 2):
 *
 *   users, sessions, account_permissions → SELECT, INSERT, UPDATE
 *     (the UPDATE privilege is *necessary*: PostgreSQL requires UPDATE on at
 *     least one column of every table named in a locking clause before
 *     FOR SHARE / FOR UPDATE is allowed at all — the money path reads all
 *     three FOR SHARE; ADR-005/Gate-3 final review decision).
 *   audit_events → SELECT, INSERT only          (append-only; guards land with
 *     the Phase-6 financial tables in one migration so the append-only set,
 *     guards and grants are enumerated by LED-001 together).
 *   admin_control → SELECT, UPDATE (updated_at)  (FOR UPDATE serialisation
 *     point of the last-admin guard, AUTHZ_MATRIX §C.2).
 *
 * P5.1 FK note: `account_permissions.account_id` references the `accounts`
 * table, which arrives in Phase 6 (schema-draft order); the FK is stubbed here
 * and added by the Phase-6 migration in the same change-set as `accounts`.
 */

const APP_ROLE = "ledgerline_app";

const TABLES = `
    -- Identity -----------------------------------------------------------------
    CREATE TABLE users (
        id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email          TEXT         NOT NULL,
        password_hash  TEXT         NOT NULL,  -- argon2id; never plaintext (ADR-006)
        role           TEXT         NOT NULL,
        status         TEXT         NOT NULL,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT users_email_unique      UNIQUE (email),
        CONSTRAINT users_role_enum         CHECK (role IN ('ADMIN','ACCOUNT_HOLDER','AUDITOR')),
        CONSTRAINT users_status_enum       CHECK (status IN ('ACTIVE','DISABLED'))
    );

    CREATE TABLE sessions (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id     BIGINT      NOT NULL REFERENCES users (id),
        token_hash  TEXT        NOT NULL,   -- sha256 of the opaque cookie token; raw token never stored (ADR-006)
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked_at  TIMESTAMPTZ NULL,       -- revocation is an UPDATE; never a DELETE (ADR-006/ADR-007)
        user_agent_hash TEXT    NULL,
        CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
    );
    -- Active-session predicate (single representation — ADR-006 §2, Gate 3):
    -- valid iff revoked_at IS NULL AND expires_at > now(). NO status column.
    CREATE INDEX sessions_user_id_idx ON sessions (user_id);

    -- Per-account grants (rows the money path locks FOR SHARE — D-13/ADR-007).
    -- account_id FK → accounts is STUBBED per P5.1; added with accounts in Phase 6.
    CREATE TABLE account_permissions (
        id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id      BIGINT      NOT NULL REFERENCES users (id),
        account_id   BIGINT      NOT NULL,
        permission   TEXT        NOT NULL,
        granted_by   BIGINT      NULL REFERENCES users (id),
        granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at   TIMESTAMPTZ NULL,
        CONSTRAINT account_permissions_action_enum
            CHECK (permission IN ('VIEW','DEPOSIT','WITHDRAW','TRANSFER','ADJUST'))
    );
    CREATE UNIQUE INDEX account_permissions_active_unique
        ON account_permissions (user_id, account_id, permission)
        WHERE revoked_at IS NULL;
    CREATE INDEX account_permissions_lookup_idx
        ON account_permissions (user_id, account_id, permission);

    -- Audit (open event vocabulary; secrets/bodies never stored — D-12)
    CREATE TABLE audit_events (
        id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_id     BIGINT      NULL REFERENCES users (id),  -- NULL for failed logins / system:bootstrap
        event_type   TEXT        NOT NULL,
        subject_type TEXT        NULL,
        subject_id   TEXT        NULL,
        reason_code  TEXT        NULL,
        metadata     JSONB       NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_events_time_idx    ON audit_events (occurred_at, id);
    CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id);

    -- Singleton serialisation row for admin-lifecycle operations (§C.2)
    CREATE TABLE admin_control (
        id           INTEGER     NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT admin_control_singleton CHECK (id = 1)
    );
    INSERT INTO admin_control (id) VALUES (1);
`;

const GRANTS = `
    GRANT SELECT, INSERT, UPDATE ON users   TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE ON sessions TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE ON account_permissions TO ${APP_ROLE};
    GRANT SELECT, INSERT         ON audit_events TO ${APP_ROLE};
    GRANT SELECT, UPDATE (updated_at) ON admin_control TO ${APP_ROLE};
`;

async function up(pgm) {
  pgm.sql(TABLES);
  pgm.sql(GRANTS);
}

async function down(pgm) {
  // Teardown is FK-safe reverse order and clears the grants (revocations are
  // implicit when the tables drop, but explicit REVOKE keeps `down` honest
  // about the privilege surface it created).
  pgm.sql(`
    REVOKE ALL ON admin_control FROM ${APP_ROLE};
    REVOKE ALL ON audit_events FROM ${APP_ROLE};
    REVOKE ALL ON account_permissions FROM ${APP_ROLE};
    REVOKE ALL ON sessions FROM ${APP_ROLE};
    REVOKE ALL ON users FROM ${APP_ROLE};
    DROP TABLE admin_control;
    DROP TABLE audit_events;
    DROP TABLE account_permissions;
    DROP TABLE sessions;
    DROP TABLE users;
  `);
}

module.exports = { up, down };
