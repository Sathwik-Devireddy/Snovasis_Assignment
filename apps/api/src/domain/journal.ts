/**
 * Pure journal builder (PHASE-06 P6.5; ADR-002).
 *
 * Builds a balanced credit-normal double-entry journal from a money command.
 * Every journal has >= 2 entries, SUM(debits) = SUM(credits), one currency.
 * The deferred constraint trigger `assert_journal_balanced` re-verifies at
 * COMMIT (I1 invariant).
 */

import type { Minor } from "./money.js";
import { isPositive, formatMinor } from "./money.js";

export type JournalEntry = {
  accountId: bigint;
  direction: "DEBIT" | "CREDIT";
  amountMinor: Minor;
  currencyCode: string;
  balanceAfterMinor?: Minor | null; // CUSTOMER rows only; NULL for SYSTEM
  accountEventSeq?: bigint | null; // allocated under the account row lock
};

export type Journal = {
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER" | "ADJUSTMENT" | "REVERSAL";
  currencyCode: string;
  entries: JournalEntry[];
  description?: string;
};

/** Validate that a journal is balanced (pure, mirrors the DB trigger). */
export function validateJournal(journal: Journal): void {
  if (journal.entries.length < 2) {
    throw new Error(`journal ${journal.type} requires >= 2 entries, got ${journal.entries.length}`);
  }
  const debits = journal.entries
    .filter((e) => e.direction === "DEBIT")
    .reduce((sum, e) => sum + e.amountMinor, 0n);
  const credits = journal.entries
    .filter((e) => e.direction === "CREDIT")
    .reduce((sum, e) => sum + e.amountMinor, 0n);
  if (debits !== credits) {
    throw new Error(
      `journal ${journal.type} is unbalanced: debits ${debits} <> credits ${credits}`
    );
  }
  const currencies = new Set(journal.entries.map((e) => e.currencyCode));
  if (currencies.size !== 1) {
    throw new Error(`journal ${journal.type} has ${currencies.size} distinct currencies`);
  }
  if (![...currencies][0] || [...currencies][0] !== journal.currencyCode) {
    throw new Error(`journal ${journal.type} has inconsistent entry currencies`);
  }
  for (const entry of journal.entries) {
    if (!isPositive(entry.amountMinor)) {
      throw new Error(`journal entry amount must be > 0, got ${entry.amountMinor}`);
    }
  }
}

/**
 * Build a deposit journal: credit destination account, debit EXTERNAL_CLEARING.
 */
export function buildDepositJournal({
  destinationAccountId,
  amount,
  currencyCode,
  externalClearingAccountId,
  description,
}: {
  destinationAccountId: bigint;
  amount: Minor;
  currencyCode: string;
  externalClearingAccountId: bigint;
  description?: string;
}): Journal {
  const journal: Journal = {
    type: "DEPOSIT",
    currencyCode,
    entries: [
      { accountId: externalClearingAccountId, direction: "DEBIT", amountMinor: amount, currencyCode },
      { accountId: destinationAccountId, direction: "CREDIT", amountMinor: amount, currencyCode },
    ],
    description: description ?? `External deposit ${formatMinor(amount)} ${currencyCode}`,
  };
  validateJournal(journal);
  return journal;
}

/**
 * Build a withdrawal journal: debit source account, credit EXTERNAL_CLEARING.
 */
export function buildWithdrawalJournal({
  sourceAccountId,
  amount,
  currencyCode,
  externalClearingAccountId,
  description,
}: {
  sourceAccountId: bigint;
  amount: Minor;
  currencyCode: string;
  externalClearingAccountId: bigint;
  description?: string;
}): Journal {
  const journal: Journal = {
    type: "WITHDRAWAL",
    currencyCode,
    entries: [
      { accountId: sourceAccountId, direction: "DEBIT", amountMinor: amount, currencyCode },
      { accountId: externalClearingAccountId, direction: "CREDIT", amountMinor: amount, currencyCode },
    ],
    description: description ?? `External withdrawal ${formatMinor(amount)} ${currencyCode}`,
  };
  validateJournal(journal);
  return journal;
}

/**
 * Build a transfer journal: debit source, credit destination.
 */
export function buildTransferJournal({
  sourceAccountId,
  destinationAccountId,
  amount,
  currencyCode,
  description,
}: {
  sourceAccountId: bigint;
  destinationAccountId: bigint;
  amount: Minor;
  currencyCode: string;
  description?: string;
}): Journal {
  const journal: Journal = {
    type: "TRANSFER",
    currencyCode,
    entries: [
      { accountId: sourceAccountId, direction: "DEBIT", amountMinor: amount, currencyCode },
      { accountId: destinationAccountId, direction: "CREDIT", amountMinor: amount, currencyCode },
    ],
    description: description ?? `Transfer ${formatMinor(amount)} ${currencyCode}`,
  };
  validateJournal(journal);
  return journal;
}
