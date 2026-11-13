---
name: prompts-log
description: Draft honest PROMPTS.md entries from real work, with TODO markers for what only the human can supply. Use at the end of any phase that used AI output.
---
# PROMPTS.md entries

Required: ≥5 dated entries; ≥2 on money integrity/concurrency/idempotency; ≥2 on authorisation/audit (stricter reading); each with a real error, how it was caught, and the fixing commit link.

Draft each entry with: date, what was asked, what the AI produced, the **specific** defect or unverified claim, how it was verified (test, SQL, review), what changed, evidence command, commit.

Rules:
- Only record defects that actually occurred. If none occurred, show the code and the checks that justify it; "it was fine" is not an entry.
- Mark anything only the human knows `TODO(human)`; never invent commit hashes, dates or outputs.
- Typical genuine catches to look for: read-then-write without a lock; balance read before the lock; refusal rolled back with the transaction; `Number` for BIGINT; idempotency check outside the transaction; key not bound to payload; role taken from the request; test that never overlaps.
