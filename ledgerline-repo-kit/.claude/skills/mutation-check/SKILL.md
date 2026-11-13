---
name: mutation-check
description: Prove a test is real by deliberately removing one protection (lock, unique index, auth check), watching it fail, then restoring. Use in Phases 8, 9 and 12.
---
# Mutation check

The judges will remove one lock or check and run your tests. Do it first.

1. Make sure the working tree is committed or stashed.
2. Remove or alter exactly one protection and predict which test fails and why. Examples: delete `FOR UPDATE` → overdraft/lost-update tests (CON-001) fail, *not* the deadlock test; reverse lock order while keeping locks → the forced-overlap deadlock test (CON-002) fails; drop the unique index → IDEM-003; drop the grant `FOR SHARE` → AUTH-008; remove a permission check → the matching AUTH test.
3. Run the named test(s). **They must fail.** If they pass, the test is not testing the protection: fix the test.
4. `git checkout -- <file>` (or revert the migration) to restore. Re-run: they must pass.
5. Record in `docs/MUTATION_LOG.md`: date, what was removed, test name, failing output excerpt, restore confirmation. Use it as evidence for a `PROMPTS.md` entry.
6. Never commit the weakened code.
