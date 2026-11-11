"use strict";

/**
 * Migration 0003 — the ledger core (PHASE-06 P6.1/P6.4/P6.8; ADR-002/ADR-005).
 *
 * Runs AS `ledgerline_owner`. Mirrors `ledgerline-repo-kit/docs/schema-draft.sql`
 * verbatim: constraint, index and trigger names are part of the design contract
 * (ADR-005 verification enumerates them).
 *
 * Creation order matters because of the foreign keys:
 *   accounts              (nothing references it yet)
 *   journal_transactions  (references users; idempotency_record_id FK added
 *                          AFTER idempotency_records exists, below)
 *   ledger_entries        (references journal_transactions + accounts)
 *   transaction_attempts  (references users + accounts)
 *   idempotency_records   (references users + journal_transactions)
 *   then ALTER TABLE journal_transactions ADD CONSTRAINT journal_idempotency_fk
 *                          REFERENCES idempotency_records(id)
 *
 * Each pgm.sql() call runs exactly ONE SQL statement (no comments, no
 * semicolons inside), per node-pg-migrate v8 semantics.
 */

const APP_ROLE = "ledgerline_app";

function sql(statement) {
  // Strip leading/trailing whitespace; caller must not include comments.
  return statement.trim();
}

async function up(pgm) {
  // ---- accounts --------------------------------------------------------------
  pgm.sql(sql(`
    CREATE TABLE accounts (
        id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_number   TEXT        NOT NULL,
        label            TEXT        NOT NULL,
        currency_code    TEXT        NOT NULL,
        kind             TEXT        NOT NULL,
        balance_minor    BIGINT      NULL,
        event_last_seq   BIGINT      NULL,
        status           TEXT        NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT accounts_kind_enum             CHECK (kind IN ('CUSTOMER','SYSTEM')),
        CONSTRAINT accounts_number_unique         UNIQUE (account_number),
        CONSTRAINT accounts_status_enum           CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
        CONSTRAINT accounts_customer_shape        CHECK (
            (kind = 'CUSTOMER' AND status IS NOT NULL
              AND balance_minor  IS NOT NULL
              AND event_last_seq IS NOT NULL)
         OR (kind = 'SYSTEM'  AND balance_minor  IS NULL
              AND event_last_seq IS NULL)
        ),
        CONSTRAINT accounts_no_overdraft          CHECK (balance_minor IS NULL OR balance_minor >= 0),
        CONSTRAINT accounts_balance_cap           CHECK (balance_minor IS NULL OR balance_minor <= 9200000000000000000)
    )
  `));
  pgm.sql(sql("CREATE INDEX accounts_kind_status_idx ON accounts (kind, status)"));

  // ---- journal_transactions --------------------------------------------------
  pgm.sql(sql(`
    CREATE TABLE journal_transactions (
        id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        type                   TEXT        NOT NULL,
        status                 TEXT        NOT NULL,
        currency_code          TEXT        NOT NULL,
        initiated_by           BIGINT      NULL REFERENCES users (id),
        idempotency_record_id  BIGINT      NULL,
        description            TEXT        NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT journal_type_enum    CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER','ADJUSTMENT','REVERSAL')),
        CONSTRAINT journal_status_enum  CHECK (status IN ('POSTED'))
    )
  `));

  // ---- ledger_entries --------------------------------------------------------
  pgm.sql(sql(`
    CREATE TABLE ledger_entries (
        id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        journal_transaction_id  BIGINT      NOT NULL REFERENCES journal_transactions (id),
        account_id              BIGINT      NOT NULL REFERENCES accounts (id),
        direction               TEXT        NOT NULL,
        amount_minor            BIGINT      NOT NULL,
        currency_code           TEXT        NOT NULL,
        balance_after_minor     BIGINT      NULL,
        account_event_seq       BIGINT      NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_direction_enum        CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive       CHECK (amount_minor > 0),
        CONSTRAINT ledger_balance_after_shape   CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0)
    )
  `));
  pgm.sql(sql("CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at, id)"));
  pgm.sql(sql("CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_transaction_id)"));

  // ---- transaction_attempts --------------------------------------------------
  // attempt_global_seq must exist before this table references it.
  pgm.sql(sql("CREATE SEQUENCE attempt_global_seq AS BIGINT START WITH 1 INCREMENT BY 1"));
  pgm.sql(sql(`
    CREATE TABLE transaction_attempts (
        id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        global_seq               BIGINT      NOT NULL DEFAULT nextval('attempt_global_seq'),
        actor_id                 BIGINT      NULL REFERENCES users (id),
        operation                TEXT        NOT NULL,
        status                   TEXT        NOT NULL,
        reason_code              TEXT        NOT NULL,
        supplied_account_ref     TEXT        NULL,
        account_id               BIGINT      NULL REFERENCES accounts (id),
        balance_at_attempt_minor BIGINT      NULL,
        account_event_seq        BIGINT      NULL,
        account_status_detail    TEXT        NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT attempts_status_enum       CHECK (status IN ('SUCCEEDED','REFUSED','FAILED')),
        CONSTRAINT attempts_status_detail     CHECK (account_status_detail IN ('SUSPENDED','CLOSED')),
        CONSTRAINT attempts_attempt_seq_positive CHECK (account_event_seq IS NULL OR account_event_seq > 0)
    )
  `));
  pgm.sql(sql("CREATE INDEX attempts_account_idx ON transaction_attempts (account_id, created_at, id)"));
  pgm.sql(sql("CREATE INDEX attempts_actor_idx   ON transaction_attempts (actor_id, created_at, id)"));

  // ---- idempotency_records ---------------------------------------------------
  pgm.sql(sql(`
    CREATE TABLE idempotency_records (
        id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        actor_id               BIGINT      NOT NULL REFERENCES users (id),
        operation              TEXT        NOT NULL,
        idempotency_key        TEXT        NOT NULL,
        request_hash           TEXT        NOT NULL,
        response_status        INTEGER     NULL,
        response_body          JSONB       NULL,
        journal_transaction_id BIGINT      NULL REFERENCES journal_transactions (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at           TIMESTAMPTZ NULL,
        expires_at             TIMESTAMPTZ NULL,
        CONSTRAINT idempotency_scope_unique UNIQUE (actor_id, operation, idempotency_key),
        CONSTRAINT idempotency_completion_pair CHECK (
            (response_status IS NULL     AND response_body IS NULL AND completed_at IS NULL)
         OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL))
    )
  `));
  pgm.sql(sql("CREATE INDEX idempotency_created_idx ON idempotency_records (created_at)"));

  // journal_transactions -> idempotency_records FK (added after both tables exist)
  pgm.sql(sql(`
    ALTER TABLE journal_transactions
        ADD CONSTRAINT journal_idempotency_fk
        FOREIGN KEY (idempotency_record_id) REFERENCES idempotency_records (id)
  `));

  // ---- grants -----------------------------------------------------------------
  pgm.sql(sql(`GRANT SELECT, INSERT ON journal_transactions, ledger_entries,
          transaction_attempts, audit_events TO ${APP_ROLE}`));
  pgm.sql(sql(`GRANT SELECT, INSERT, UPDATE ON idempotency_records TO ${APP_ROLE}`));
  pgm.sql(sql(`GRANT SELECT ON accounts TO ${APP_ROLE}`));
  pgm.sql(sql(`GRANT UPDATE (balance_minor, event_last_seq, updated_at, status) ON accounts TO ${APP_ROLE}`));
  pgm.sql(sql(`GRANT USAGE ON SEQUENCE attempt_global_seq TO ${APP_ROLE}`));

  // ---- append-only triggers ---------------------------------------------------
  pgm.sql(sql(`
    CREATE OR REPLACE FUNCTION refuse_append_only_trig() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'append-only violation: % Table % cannot be updated or deleted at runtime (%)',
            TG_OP, TG_TABLE_NAME, session_user;
    END $$;
  `));

  pgm.sql(sql(`CREATE TRIGGER journal_transactions_append_only
        BEFORE UPDATE OR DELETE ON journal_transactions
        FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig()`));
  pgm.sql(sql(`CREATE TRIGGER journal_transactions_no_truncate
        BEFORE TRUNCATE ON journal_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig()`));

  pgm.sql(sql(`CREATE TRIGGER ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig()`));
  pgm.sql(sql(`CREATE TRIGGER ledger_entries_no_truncate
        BEFORE TRUNCATE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig()`));

  pgm.sql(sql(`CREATE TRIGGER attempts_append_only
        BEFORE UPDATE OR DELETE ON transaction_attempts
        FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig()`));
  pgm.sql(sql(`CREATE TRIGGER attempts_no_truncate
        BEFORE TRUNCATE ON transaction_attempts
        FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig()`));

  pgm.sql(sql(`CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig()`));
  pgm.sql(sql(`CREATE TRIGGER audit_events_no_truncate
        BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig()`));
}

async function down(pgm) {
  pgm.sql(sql(`REVOKE ALL ON attempt_global_seq FROM ${APP_ROLE}`));
  pgm.sql(sql(`DROP SEQUENCE IF EXISTS attempt_global_seq`));
  pgm.sql(sql(`REVOKE ALL ON accounts FROM ${APP_ROLE}`));
  pgm.sql(sql(`REVOKE ALL ON idempotency_records FROM ${APP_ROLE}`));
  pgm.sql(sql(`REVOKE ALL ON transaction_attempts FROM ${APP_ROLE}`));
  pgm.sql(sql(`REVOKE ALL ON ledger_entries FROM ${APP_ROLE}`));
  pgm.sql(sql(`REVOKE ALL ON journal_transactions FROM ${APP_ROLE}`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS attempts_no_truncate ON transaction_attempts`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS attempts_append_only ON transaction_attempts`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS journal_transactions_no_truncate ON journal_transactions`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS journal_transactions_append_only ON journal_transactions`));
  pgm.sql(sql(`ALTER TABLE journal_transactions DROP CONSTRAINT IF EXISTS journal_idempotency_fk`));
  pgm.sql(sql(`DROP TABLE idempotency_records`));
  pgm.sql(sql(`DROP TABLE transaction_attempts`));
  pgm.sql(sql(`DROP TABLE ledger_entries`));
  pgm.sql(sql(`DROP TABLE journal_transactions`));
  pgm.sql(sql(`DROP TABLE accounts`));
}

module.exports = { up, down };
