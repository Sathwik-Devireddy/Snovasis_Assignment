"use strict";

/**
 * Migration 0004 — journal balance enforcement + system account seed
 * (PHASE-06 P6.2/P6.3; ADR-002/ADR-005).
 *
 * Runs AS `ledgerline_owner`. Mirrors `ledgerline-repo-kit/docs/schema-draft.sql`
 * verbatim: trigger/function names are part of the design contract.
 *
 * Creates:
 *   - assert_journal_balanced() constraint-trigger function (anchored on BOTH
 *     journal_transactions and ledger_entries; fires at COMMIT when deferred)
 *   - journal_transactions_journals_balanced — deferred constraint trigger on
 *     journal_transactions INSERT (catches zero-entry journals)
 *   - ledger_entries_journals_balanced — deferred constraint trigger on
 *     ledger_entries INSERT (aggregates the whole journal at COMMIT)
 *   - EXTERNAL_CLEARING system account seed (destination for external deposits,
 *     source for external withdrawals; never locked or cached)
 */

function sql(statement) {
  return statement.trim();
}

async function up(pgm) {
  // ---- assert_journal_balanced() function ------------------------------------
  pgm.sql(sql(`
    CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $$
    DECLARE
        v_journal_id          BIGINT;
        v_entry_count         BIGINT;
        v_debits              NUMERIC;
        v_credits             NUMERIC;
        v_distinct_currencies BIGINT;
        v_journal_currency    TEXT;
    BEGIN
        IF TG_TABLE_NAME = 'journal_transactions' THEN
            v_journal_id := NEW.id;
        ELSIF TG_TABLE_NAME = 'ledger_entries' THEN
            v_journal_id := NEW.journal_transaction_id;
        ELSE
            RAISE EXCEPTION 'assert_journal_balanced: unexpected trigger table %', TG_TABLE_NAME;
        END IF;

        SELECT count(*),
               COALESCE(sum(amount_minor) FILTER (WHERE direction = 'DEBIT'),  0),
               COALESCE(sum(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0),
               count(DISTINCT currency_code)
          INTO v_entry_count, v_debits, v_credits, v_distinct_currencies
          FROM ledger_entries
         WHERE journal_transaction_id = v_journal_id;

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
        RETURN NULL;
    END $$;
  `));

  // ---- deferred constraint triggers ------------------------------------------
  pgm.sql(sql(`
    CREATE CONSTRAINT TRIGGER journal_transactions_journals_balanced
        AFTER INSERT ON journal_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced()
  `));
  pgm.sql(sql(`
    CREATE CONSTRAINT TRIGGER ledger_entries_journals_balanced
        AFTER INSERT ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced()
  `));

  // ---- EXTERNAL_CLEARING system account seed (P6.2) --------------------------
  pgm.sql(sql(`
    INSERT INTO accounts (account_number, label, currency_code, kind, status)
    VALUES ('EXTERNAL_CLEARING', 'External clearing account', 'USD', 'SYSTEM', 'ACTIVE')
  `));
}

async function down(pgm) {
  pgm.sql(sql(`DROP TRIGGER IF EXISTS ledger_entries_journals_balanced ON ledger_entries`));
  pgm.sql(sql(`DROP TRIGGER IF EXISTS journal_transactions_journals_balanced ON journal_transactions`));
  pgm.sql(sql(`DROP FUNCTION IF EXISTS assert_journal_balanced()`));
  pgm.sql(sql(`DELETE FROM accounts WHERE account_number = 'EXTERNAL_CLEARING'`));
}

module.exports = { up, down };
