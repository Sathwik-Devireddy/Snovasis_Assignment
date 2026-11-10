-- ============================================================================
-- LedgerLine — schema draft (Phase 3, P3.7)
-- Status: DRAFT FOR ADR/GATE 3 REVIEW — NOT A MIGRATION.
-- After Gate 3 acceptance (and H-4 host-role verification), this becomes
-- versioned SQL under db/migrations/ run by node-pg-migrate.
--
-- Conventions
--  - Money and event sequences are BIGINT; at every textual boundary they are
--    JSON strings (ADR-002, T-049). Columns stay BIGINT.
--  - Constraint/trigger/sequence names are part of the design contract (ADR-005
--    verification enumerates them). Renaming requires an ADR amendment.
--  - Normative words in comments ("must", "never") mirror the ADRs; if the SQL
--    and an ADR disagree, the ADR is normative and the draft is wrong.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sequences
-- ----------------------------------------------------------------------------
-- Non-transactional, deliberately NOT gap-free (Rev 2 decision; ADR-004 §3):
-- used for unsequenced attempt tiebreaks (statement interleave, audit views),
-- never as a conservation or assertion primitive (INV-001).
CREATE SEQUENCE attempt_global_seq AS BIGINT START WITH 1 INCREMENT BY 1;

-- Singleton serialisation row for administrator-lifecycle operations
-- (approved Gate 2 decision; AUTHZ_MATRIX §C.2; ADMIN-001/002).
CREATE TABLE admin_control (
    id           INTEGER     NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_control_singleton CHECK (id = 1)
);

-- ----------------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------------
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
    token_hash  TEXT        NOT NULL,          -- sha256 of the opaque cookie token; raw token never stored (ADR-006)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ NULL,              -- revocation is an UPDATE (admin lifecycle); never a DELETE (ADR-006/ADR-007)
    user_agent_hash TEXT    NULL,
    CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);
-- Active-session predicate (single representation — ADR-006 §2, Gate 3 final review):
-- a session is valid iff revoked_at IS NULL AND expires_at > now().
-- There is deliberately NO status column; revocation is exactly
--   UPDATE sessions SET revoked_at = now() [WHERE id = ... / user_id = ...]
-- taken FOR UPDATE so it serialises against the money path's FOR SHARE read.
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- ----------------------------------------------------------------------------
-- Accounts (kind-check shape is D-6 / ADR-002)
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_number   TEXT        NOT NULL,      -- opaque public identifier
    label            TEXT        NOT NULL,
    currency_code    TEXT        NOT NULL,
    kind             TEXT        NOT NULL,      -- CUSTOMER holds cache+counter; SYSTEM is ledger-derived (never locked/cached)
    -- Cached read model + event counter: CUSTOMER-only
    balance_minor    BIGINT      NULL,
    event_last_seq   BIGINT      NULL,
    status           TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT accounts_kind_enum             CHECK (kind IN ('CUSTOMER','SYSTEM')),
    -- kind/system columns: EXTERNAL_CLEARING, ADJUSTMENT (ADJUSTMENT kind reserved, H-5)
    CONSTRAINT accounts_number_unique         UNIQUE (account_number),
    CONSTRAINT accounts_status_enum           CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
    -- I3 backstop (no overdraft) — CUSTOMER rows only:
    CONSTRAINT accounts_customer_shape        CHECK (
        (kind = 'CUSTOMER' AND status IS NOT NULL
          AND balance_minor  IS NOT NULL
          AND event_last_seq IS NOT NULL)
     OR (kind = 'SYSTEM'  AND balance_minor  IS NULL
          AND event_last_seq IS NULL)
    ),
    -- No-overdraft backstop; upper cap keeps per-account sums inside BIGINT (D-4)
    CONSTRAINT accounts_no_overdraft          CHECK (balance_minor IS NULL OR balance_minor >= 0),
    CONSTRAINT accounts_balance_cap           CHECK (balance_minor IS NULL OR balance_minor <= 9200000000000000000)
);
CREATE INDEX accounts_kind_status_idx ON accounts (kind, status);

-- ----------------------------------------------------------------------------
-- Per-account grants (rows carry the authority the money path locks FOR SHARE — D-13/ADR-007)
-- Permission vocabulary is generic; capability boundaries are enforced by
-- docs/AUTHZ_MATRIX.md §A/§B (DEPOSIT is ADMIN-role authority under H-2; ADJUST
-- is an H-5 placeholder — no v1 code path grants or exercises it).
-- ----------------------------------------------------------------------------
CREATE TABLE account_permissions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id),
    account_id   BIGINT      NOT NULL REFERENCES accounts (id),
    permission   TEXT        NOT NULL,
    granted_by   BIGINT      NULL REFERENCES users (id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ NULL,             -- revocation keeps the row (audit) — a new grant is a new row
    CONSTRAINT account_permissions_action_enum CHECK (permission IN ('VIEW','DEPOSIT','WITHDRAW','TRANSFER','ADJUST'))
);
-- NOTE: the "no self-grant" rule (admin may not grant a permission to self) is an
-- application+audit rule (AUTHZ_MATRIX §C), not a schema constraint; it is checked in
-- the grant path and audited. It lives in code, not in this file.

CREATE UNIQUE INDEX account_permissions_active_unique
    ON account_permissions (user_id, account_id, permission)
    WHERE revoked_at IS NULL;
CREATE INDEX account_permissions_lookup_idx
    ON account_permissions (user_id, account_id, permission);

-- ----------------------------------------------------------------------------
-- Journal + ledger (credit-normal double entry — ADR-002; I1 deferrable check)
-- ADJUSTMENT / REVERSAL types are reserved for the H-5-deferred feature:
-- no v1 code path inserts them.
-- ----------------------------------------------------------------------------
CREATE TABLE journal_transactions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type           TEXT        NOT NULL,
    status         TEXT        NOT NULL,
    currency_code  TEXT        NOT NULL,
    initiated_by   BIGINT      NULL REFERENCES users (id),
    idempotency_record_id BIGINT NULL,      -- FK added below (creation order); refused outcomes keep NULL
    description    TEXT        NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT journal_type_enum    CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER','ADJUSTMENT','REVERSAL')),
    CONSTRAINT journal_status_enum  CHECK (status IN ('POSTED'))
);

CREATE TABLE ledger_entries (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    journal_transaction_id  BIGINT      NOT NULL REFERENCES journal_transactions (id),
    account_id              BIGINT      NOT NULL REFERENCES accounts (id),
    direction               TEXT        NOT NULL,
    amount_minor            BIGINT      NOT NULL,
    currency_code           TEXT        NOT NULL,
    balance_after_minor     BIGINT      NULL,   -- customer rows only; SYSTEM rows NULL & seq NULL (ADR-002)
    account_event_seq       BIGINT      NULL,   -- allocated under the account row lock; NULL for SYSTEM
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_direction_enum        CHECK (direction IN ('DEBIT','CREDIT')),
    CONSTRAINT ledger_amount_positive       CHECK (amount_minor > 0),
    CONSTRAINT ledger_balance_after_shape   CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0)
);
CREATE INDEX ledger_entries_account_idx
    ON ledger_entries (account_id, created_at, id);
CREATE INDEX ledger_entries_journal_idx
    ON ledger_entries (journal_transaction_id);

-- I1: for every journal: >= 2 entries, SUM(debits) = SUM(credits), one consistent
-- currency; checked at COMMIT (INV-001 preserves global conservation on top).
--
-- ZERO-ENTRY-JOURNAL DESIGN (Gate 3 final review). A trigger anchored only on
-- ledger_entries can never catch a journal row inserted with no entries (no entry
-- row means no trigger event). The check is therefore anchored on BOTH tables as
-- DEFERRABLE INITIALLY DEFERRED constraint triggers sharing one function:
--   journal_transactions_journals_balanced -- fires on every journal INSERT even an
--                                           -- entry-less one -> catches zero-entry
--   ledger_entries_journals_balanced       -- fires per entry; aggregates the whole
--                                           -- journal at its COMMIT (also guards an
--                                           -- out-of-band later INSERT of entries against
--                                           -- an existing POSTED journal, which the journal
--                                           -- trigger alone would not see)
-- Verified PostgreSQL semantics: constraint triggers are AFTER-ROW triggers and flow
-- at the END of the transaction when deferred, where every row inserted anywhere in
-- the same transaction is visible to the aggregate — so statement order (journal
-- before entries) is irrelevant. Duplicate evaluation of the same journal in one
-- commit (journal trigger + one firing per entry) is harmless: the check is a
-- read-only aggregate over final row versions.
-- Any failure RAISEs inside the deferred phase and aborts the ENTIRE transaction —
-- journal, entries, balances, counter bumps and attempt rows all roll back; no
-- partial journal state can ever commit (ACCEPTANCE JBL-001).

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp   -- hardened: only the app schema + pg_temp are searched
AS $$
DECLARE
    v_journal_id          BIGINT;
    v_entry_count         BIGINT;
    v_debits              NUMERIC;   -- sum(bigint) returns numeric; exact, no overflow
    v_credits             NUMERIC;
    v_distinct_currencies BIGINT;
    v_journal_currency    TEXT;
BEGIN
    -- Identify the affected journal: dispatch on which table fired us.
    IF TG_TABLE_NAME = 'journal_transactions' THEN
        v_journal_id := NEW.id;                     -- the journal row itself
    ELSIF TG_TABLE_NAME = 'ledger_entries' THEN
        v_journal_id := NEW.journal_transaction_id; -- one of the journal's entries
    ELSE
        RAISE EXCEPTION 'assert_journal_balanced: unexpected trigger table %', TG_TABLE_NAME;
    END IF;

    -- Deferred execution point: with INITIALLY DEFERRED this runs at COMMIT, so this
    -- aggregate sees the FINAL entry set of the transaction for this journal and the
    -- final committed journal row.
    SELECT count(*),
           COALESCE(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'),  0),
           COALESCE(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0),
           count(DISTINCT currency_code)
      INTO v_entry_count, v_debits, v_credits, v_distinct_currencies
      FROM ledger_entries
     WHERE journal_transaction_id = v_journal_id;

    -- How invalid states are prevented from committing: every invariant failure
    -- RAISEs; an exception from a deferred constraint trigger aborts the whole
    -- transaction at COMMIT (nothing partial persists).
    IF v_entry_count = 0 THEN
        RAISE EXCEPTION 'journal % is empty (0 entries); a POSTED journal requires >= 2 entries',
            v_journal_id;
    END IF;
    IF v_entry_count = 1 THEN
        RAISE EXCEPTION 'journal % has 1 entry; a POSTED journal requires >= 2 entries',
            v_journal_id;
    END IF;
    IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'journal % is unbalanced: debits % <> credits %',
            v_journal_id, v_debits, v_credits;
    END IF;
    SELECT currency_code INTO v_journal_currency
      FROM journal_transactions WHERE id = v_journal_id;
    IF v_journal_currency IS NULL OR v_distinct_currencies <> 1
       OR v_journal_currency <> (SELECT currency_code FROM ledger_entries
                                  WHERE journal_transaction_id = v_journal_id LIMIT 1) THEN
        RAISE EXCEPTION 'journal % has inconsistent entry currencies (journal currency: %, distinct entry currencies: %)',
            v_journal_id, v_journal_currency, v_distinct_currencies;
    END IF;
    -- Per-entry amount_minor > 0 and direction ∈ {DEBIT,CREDIT} are column CHECKs;
    -- combined with the balance invariant above, a valid journal necessarily holds
    -- >= 1 debit and >= 1 credit entry.
    RETURN NULL;   -- AFTER trigger; return value is ignored
END $$;

CREATE CONSTRAINT TRIGGER journal_transactions_journals_balanced
    AFTER INSERT ON journal_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE CONSTRAINT TRIGGER ledger_entries_journals_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ----------------------------------------------------------------------------
-- Attempts / audit (append-only as a set: INSERT only; see ADR-005 triggers)
-- ----------------------------------------------------------------------------
CREATE TABLE transaction_attempts (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    global_seq               BIGINT      NOT NULL DEFAULT nextval('attempt_global_seq'),  -- tiebreak-only ordering (unsequenced rows)
    actor_id                 BIGINT      NULL REFERENCES users (id),   -- NULL only where the protocol allows (failed/unknown identity rows)
    operation                TEXT        NOT NULL,
    status                   TEXT        NOT NULL,
    reason_code              TEXT        NOT NULL,  -- closed external code list (REFUSAL_CODES §3); audit-internal codes differ
    supplied_account_ref     TEXT        NULL,      -- verbatim caller-supplied identifier, always recorded when present (AUTH-009)
    account_id               BIGINT      NULL REFERENCES accounts (id), -- absent for nonexistent targets (AUTH-009)
    balance_at_attempt_minor BIGINT      NULL,      -- ONLY where the balance was measured under the lock (§4)
    account_event_seq        BIGINT      NULL,      -- ONLY for refusals written under the account lock; bump alongside events
    account_status_detail    TEXT        NULL,      -- SUSPENDED/CLOSED; ADMIN/AUDITOR audit views ONLY (never external, never statement)
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attempts_status_enum       CHECK (status IN ('SUCCEEDED','REFUSED','FAILED')),
    CONSTRAINT attempts_status_detail     CHECK (account_status_detail IN ('SUSPENDED','CLOSED')),
    -- detail may exist only on ACCOUNT_NOT_ACTIVE rows written under lock (internal reasons carry it)
    CONSTRAINT attempts_attempt_seq_positive CHECK (account_event_seq IS NULL OR account_event_seq > 0)
);
CREATE INDEX attempts_account_idx ON transaction_attempts (account_id, created_at, id);
CREATE INDEX attempts_actor_idx   ON transaction_attempts (actor_id, created_at, id);

CREATE TABLE audit_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id     BIGINT      NULL REFERENCES users (id),   -- NULL allowed for failed logins
    event_type   TEXT        NOT NULL,   -- LOGIN_SUCCEEDED, LOGIN_FAILED, PERMISSION_GRANTED, PERMISSION_REVOKED,
                                         -- ACCOUNT_CREATED, ADMIN_STATUS_CHANGE, SESSION_REVOKED, ...
                                         -- (IDEMPOTENT_REPLAY is a reserved-v2 identifier, NOT written
                                         --  in v1 — the replay gate is evaluation-only; ADR-004 §4)
                                         -- open vocabulary; raw secrets and bodies never stored (AGENTS/D-12)
    subject_type TEXT        NULL,
    subject_id   TEXT        NULL,
    reason_code  TEXT        NULL,
    metadata     JSONB       NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_time_idx    ON audit_events (occurred_at, id);
CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id);

-- ----------------------------------------------------------------------------
-- Idempotency (single atomic model — no PROCESSING state; ADR-004)
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_records (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id               BIGINT      NOT NULL REFERENCES users (id),
    operation              TEXT        NOT NULL,
    idempotency_key        TEXT        NOT NULL,   -- <= 64 chars, opaque (client contract, @IDEMPOTENCY_BEHAVIORS)
    request_hash           TEXT        NOT NULL,   -- canonical payload hash (IDEM-002)
    response_status        INTEGER     NULL,       -- filled at commit with the outcome to replay
    response_body          JSONB       NULL,       -- semantic-replay artifact: same status + business values.
                                                    -- NOT byte-identical: JSONB normalises key order,
                                                    -- whitespace and numeric formatting (ADR-004 §1a);
                                                    -- money/sequence values stay JSON strings (T-049)
    -- NO replay-side writes in v1 (ADR-004 §4): no replay_count column, no
    -- idempotency_replays table — a passing replay is evaluation-only and its
    -- only trace is the `replayed: true` field in the response envelope.
    -- Per-replay accounting is deferred and requires explicit human opt-in.
    journal_transaction_id BIGINT      NULL REFERENCES journal_transactions (id), -- NULL for refused outcomes
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ NULL,
    expires_at             TIMESTAMPTZ NULL,       -- always NULL in v1: no expiry (T-017/T-038, ADR-004 §4)
    CONSTRAINT idempotency_scope_unique UNIQUE (actor_id, operation, idempotency_key),
    -- idempotent requests are for authenticated actors only (session checked first — D-8 step 1)
    CONSTRAINT idempotency_completion_pair CHECK (
        (response_status IS NULL     AND response_body IS NULL AND completed_at IS NULL)
     OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idempotency_created_idx ON idempotency_records (created_at);

ALTER TABLE journal_transactions
    ADD CONSTRAINT journal_idempotency_fk
    FOREIGN KEY (idempotency_record_id) REFERENCES idempotency_records (id);

-- ----------------------------------------------------------------------------
-- Append-only guards (ADR-005): runtime CANNOT edit history. Two layers:
--  (a) role grants — ledgerline_app: SELECT, INSERT only on the tables below;
--      no UPDATE, DELETE, TRUNCATE (grant section drafted separately in Phase 4,
--      not runnable in this draft file — the role/GRANT block is commented).
--  (b) triggers that reject mutation even if a grant is accidentally widened.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_append_only_trig() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'append-only violation: % Table % cannot be updated or deleted at runtime (%)',
        TG_OP, TG_TABLE_NAME, session_user;
END $$;

CREATE TRIGGER journal_transactions_append_only
    BEFORE UPDATE OR DELETE ON journal_transactions
    FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig();
CREATE TRIGGER journal_transactions_no_truncate
    BEFORE TRUNCATE ON journal_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig();

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig();
CREATE TRIGGER ledger_entries_no_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig();

CREATE TRIGGER attempts_append_only
    BEFORE UPDATE OR DELETE ON transaction_attempts
    FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig();
CREATE TRIGGER attempts_no_truncate
    BEFORE TRUNCATE ON transaction_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig();

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION refuse_append_only_trig();
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION refuse_append_only_trig();

-- sessions/audit_events: sessions rows are revoked via column update (an authorised
-- lifecycle UPDATE, not app-user history); audit_events is INSERT-only for the app.
-- accounts updates happen only inside the posting/lifecycle transactions via the
-- decided column-level grant list (ADR-005 item 2; ADR-003); rows themselves never.
-- users/passwords updates follow the admin lifecycle (AUTHZ_MATRIX); deletion never.

-- Planned grants (drafted; becomes part of the migration/bootstrap after Gate 3):
--  CREATE ROLE ledgerline_owner NOLOGIN;
--  CREATE ROLE ledgerline_app   LOGIN;              -- password from host config (H-4 verified)
--  GRANT SELECT, INSERT ON journal_transactions, ledger_entries,
--            transaction_attempts, audit_events
--     TO ledgerline_app;   -- the APPEND-ONLY set: NO UPDATE/DELETE/TRUNCATE, ever
--  GRANT SELECT, INSERT, UPDATE ON idempotency_records TO ledgerline_app;
--     -- UPDATE only to finalise the stored response on the key row the same
--     -- claiming transaction inserted (D-8 step 7); NO DELETE (no expiry in v1,
--     -- deletion is owner-role SQL only, disclosed — T-038).
--  GRANT SELECT, INSERT, UPDATE ON account_permissions, sessions, users
--     TO ledgerline_app;   -- lifecycle tables (grant rows, revocation, admin lifecycle).
--     -- the UPDATE privilege here is also *necessary*: PostgreSQL requires UPDATE on at
--     -- least one column of every table named in a locking clause (FOR SHARE/FOR UPDATE)
--     -- before the lock is permitted at all (SELECT ref, verified 2026-11-08), and the
--     -- money path reads all of these FOR SHARE.
--  GRANT SELECT ON accounts TO ledgerline_app;  -- read path: balances, statements
--  -- DECIDED AT GATE 3 (finding 4 — closes the former permission gap): accounts
--  -- balance/counter/status updates use a DIRECT COLUMN-LEVEL grant:
--  GRANT UPDATE (balance_minor, event_last_seq, updated_at, status) ON accounts
--     TO ledgerline_app;
--  -- ^ balances + counter written only inside the posting transaction that already
--  --   holds the account row FOR UPDATE lock (ADR-003); the column-level list also
--  --   satisfies the locking-clause UPDATE-privilege rule for that FOR UPDATE.
--  --   status only inside the audited admin lifecycle (AUTHZ_MATRIX §F). Every other
--  --   accounts column is immutable post-creation. Considered-not-chosen: a SECURITY
--  --   DEFINER wrapper function (ADR-005 item 2 — extra in-lock hop, write hidden in a
--  --   function body).
--  GRANT SELECT, UPDATE (updated_at) ON admin_control TO ledgerline_app;
--     -- DECIDED AT GATE 3 FINAL REVIEW (closes the deferred admin_control question):
--     -- FOR UPDATE requires UPDATE privilege on at least one column of the locked table
--     -- (PostgreSQL SELECT reference, verified 2026-11-08). updated_at is the only column
--     -- admin lifecycle code touches under the lock, so this is the minimal sufficient
--     -- grant AND it stays harmless: id is immutable, no DELETE/TRUNCATE anywhere.
--     -- FOR SHARE as the serialisation point would NOT work (share locks do not conflict
--     -- with each other — two demotions would both proceed); the lock kind stays FOR UPDATE.
--     -- Considered-not-chosen: a SECURITY DEFINER lock function owned by ledgerline_owner
--     -- (same objections as the accounts decision — extra hop, hidden write, ownership/
--     -- search_path review burden). Human may override at Gate 3.
--  -- ledgerline_app receives NO UPDATE/DELETE/TRUNCATE anywhere on the append-only set.
--  GRANT USAGE ON SEQUENCE attempt_global_seq TO ledgerline_app;
--  -- ledgerline_owner: DDL/migrations only (CREATE/ALTER/DROP). Its UPDATE/DELETE on
--  -- ledger DATA rows is ALSO rejected by the append-only triggers (triggers fire for
--  -- every session; DDL never fires them) — the sole bypass, an explicit
--  -- ALTER TABLE ... DISABLE TRIGGER, is the disclosed residual (ADR-005 item 5, T-026).

-- ----------------------------------------------------------------------------
-- Draft-review checklist (before this becomes a migration):
--  [x] every CHECK/UNIQUE/FK named
--  [x] append-only triggers named (ADR-005 verification enumerates them)
--  [x] grant shape for accounts UPDATE decided at Gate 3: direct column-level
--      grants (balance_minor, event_last_seq, updated_at, status); SECURITY
--      DEFINER considered and not chosen (ADR-005 item 2).
--  [x] admin_control FOR UPDATE privilege placement decided at Gate 3 final
--      review: SELECT, UPDATE (updated_at) — minimal grant satisfying the PG
--      locking-clause rule; SECURITY DEFINER lock function considered, not chosen.
--  [x] assert_journal_balanced() body defined (two deferred constraint triggers:
--      journal_transactions + ledger_entries; zero-entry journals caught at COMMIT)
--  [ ] remaining syntax polish (this file is a design artifact; it is not executed)
-- ============================================================================
