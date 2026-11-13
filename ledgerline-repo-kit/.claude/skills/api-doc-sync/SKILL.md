---
name: api-doc-sync
description: Keep docs/API.md in step with the code; every endpoint states who may call it and what it does to the money. Use when adding or changing endpoints.
---
# API documentation

For each endpoint document: method and path; roles; account permission required; request schema; response schema; `Idempotency-Key` requirement; transaction boundary; ledger effect (entries written, balances changed, or "none"); refusal behaviour and reason codes; replay behaviour; test IDs.
Check at the end that the list of routes registered in the app equals the list in `docs/API.md`.
