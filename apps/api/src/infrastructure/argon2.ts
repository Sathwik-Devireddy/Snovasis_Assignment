import { hash, verify, type HashOptions } from "argon2";

/**
 * Password hashing (PHASE-05 P5.3; ADR-006 decision 1).
 *
 * argon2id with per-user random salt (salt is embedded in the encoded hash —
 * never stored or logged separately). Parameters are the OWASP-recommended
 * minimum m=19456 KiB, t=2, p=1; they are recorded in this file and never
 * exposed to callers. Plaintext passwords never enter logs; the encoded hash
 * is only ever compared.
 */

const argonidOptions: HashOptions = {
  type: 2, // argon2id
  memoryCost: 19_456, // KiB (19 MiB) — OWASP 2024 minimum
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, argonidOptions);
}

/** Single boolean result; timing/cost live inside argon2 — no secret leaked. */
export function verifyPassword(passwordHash: string, plaintextCandidate: string): Promise<boolean> {
  return verify(passwordHash, plaintextCandidate, argonidOptions);
}

/** True iff the encoded hash uses the argon2id type marker (used by tests/audits). */
export function isArgon2idHash(passwordHash: string): boolean {
  return passwordHash.startsWith("$argon2id$");
}
