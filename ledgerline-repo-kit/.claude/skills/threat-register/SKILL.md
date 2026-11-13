---
name: threat-register
description: Maintain THREATS.md honestly: add threats, link tests, change status only with evidence, record accepted risks. Use whenever a threat, test or control changes.
---
# Threat register upkeep

- Statuses: `OPEN`, `IN_PROGRESS`, `MITIGATED`, `ACCEPTED`.
- `MITIGATED` requires: the control exists in code, a named test exists, the test **passed in a run you pasted**, and (for race/lock controls) a mutation check was recorded.
- `ACCEPTED` requires: why it cannot be closed now, impact, compensating control, owner, and the exact condition under which the risk is real. Honest open risks earn marks; false closures cost them.
- Add new threats with the next free ID and the same columns. Add a "Found by" note when you discovered it yourself (graders reward findings they did not list).
- Never edit a threat to make a failing result look fine.
