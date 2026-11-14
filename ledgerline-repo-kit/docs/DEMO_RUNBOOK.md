# Demo Runbook — repeatable local demo (Phase 3)

*Date: 2026-11-14 · Verified: seed determinism re-verified live this phase (see §3 note)*

This runbook produces the full 13-step role journey on the **local** stack
(Docker PostgreSQL 17 `:15432`, Redis `:16379`, API `:4000`, web `:3000`).
It uses **local demo accounts only** — never production credentials, and the
production bootstrap slot stays reserved for the owner's real administrator.

**Safety properties used throughout:** every seed insert is keyed on a
deterministic natural key with `ON CONFLICT DO NOTHING`, and every seed money
movement uses a FIXED idempotency key — re-running any step is safe and
replays instead of double-posting (T-044 / SEED-001, verified live this phase).
No step deletes existing data; there is **no cleanup step**. The local
database may contain ~800 old test-fixture accounts from automated tests —
they are harmless, isolated, and intentionally left alone.

## 0. Prerequisites (once)

```powershell
npm install                       # workspaces + prisma generate
docker compose up -d              # PostgreSQL 17 + Redis 8 (loopback 15432/16379)
npm run db:migrate:bootstrap      # roles/migration 0001 (superuser) — idempotent
npm run db:migrate                # migrations 0002..0006 as ledgerline_owner — idempotent
```

Copy `.env.example` to `.env` and fill the `CHANGE_ME_*` values first (see
[`DEPLOYMENT.md`](DEPLOYMENT.md) for the variable list; never commit `.env`).

## 0b. Start the API (local, pointed at Docker)

PowerShell — build the runtime env from the repo `.env` but override the
service URLs to the Docker ports (the repo `.env` may target the cloud):

```powershell
cd apps/api
$vars = @{}
Get-Content ..\..\.env | ForEach-Object { if ($_ -match "^([A-Z_]+)=(.*)$") { $vars[$matches[1]] = $matches[2] } }
$env:DATABASE_URL           = "postgresql://ledgerline_app:$($vars['APP_ROLE_PASSWORD'])@127.0.0.1:15432/balancevault"
$env:DATABASE_URL_OWNER     = "postgresql://ledgerline_owner:$($vars['OWNER_ROLE_PASSWORD'])@127.0.0.1:15432/balancevault"
$env:DATABASE_URL_BOOTSTRAP = "postgresql://balancevault_bootstrap:$($vars['POSTGRES_BOOTSTRAP_PASSWORD'])@127.0.0.1:15432/balancevault"
$env:REDIS_URL              = "redis://127.0.0.1:16379"
node --import tsx src/server.ts        # API on :4000
```

Readiness check (liveness vs readiness are distinct):

```powershell
curl http://127.0.0.1:4000/health   # → {"ok":true}                    (liveness)
curl http://127.0.0.1:4000/ready    # → {"ok":true,"checks":{"postgres":"ok","redis":"ok"}}
```

For browser-based demos, run `npm run dev:web` in a second terminal (web on
:3000) and do steps 1–13 through the UI; the curl transcripts below are the
scriptable equivalent. **Recording tip:** never capture the password field or
the cookie jar in a screenshot — use the browser UI or redact the terminal.

## 0c. Create the demo ADMIN + demo data (idempotent, first run)

The first administrator is created by the **controlled bootstrap script**
(never by a request; it refuses once any ADMIN exists):

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:BOOTSTRAP_ADMIN_PASSWORD="<demo-only password>"
node --env-file=.env apps/api/scripts/bootstrap.mjs
```

Then the demo seed (holder + auditor + demo accounts + grants; synthetic
movement only when `DEMO_ADMIN_*` is set):

```powershell
$env:DATABASE_URL="postgresql://ledgerline_app:<runtime password>@127.0.0.1:15432/balancevault"
$env:DEMO_SEED_PASSWORD="<demo-only password>"
$env:DEMO_ADMIN_EMAIL="demo.admin@balancevault.local"
$env:DEMO_ADMIN_PASSWORD="<demo-only password>"
$env:DEMO_API_URL="http://127.0.0.1:4000"
node apps/api/scripts/seed-demo.mjs
```

> **Phase 3 verification:** this seed was re-run against a live local API and
> replayed (`replayed:true` on both fixed-key movements, balances unchanged) —
> the demo is deterministic and repeatable. The seeded state after one run:
> `DEMO-HOLDER-ACCOUNT` = 250,000 paise in, 50,000 transferred out; the demo
> transfer is performed **by the holder** (a TRANSFER grant is required for
> every actor, including admins — AUTH-004 forbids the admin granting themself).

Set the demo password once per shell (used in the login steps below):

```powershell
$demoPw = "<demo-only password>"     # demo-only; rotate for any real deployment
```

## The 13 demo steps

Cookie jars live in the temp dir; every money call carries an `Idempotency-Key`.

```powershell
$tmp = "C:\Users\devir\AppData\Local\Temp\opencode"
```

### 1. Login as ADMIN

```powershell
curl.exe -s -c "$tmp\admin.jar" -H "Content-Type: application/json" `
  -d '{\"email\":\"demo.admin@balancevault.local\",\"password\":\"REDACTED\"}' `
  http://127.0.0.1:4000/login
# → 200 {"user":{...,"role":"ADMIN"}}
```

(In an interactive shell pass the real password, not the REDACTED placeholder.)

### 2. Create an ACCOUNT_HOLDER (admin)

```powershell
curl.exe -s -b "$tmp\admin.jar" -H "Content-Type: application/json" `
  -d '{\"email\":\"demo.holder2@balancevault.local\",\"password\":\"Holder-Demo-2026!\",\"role\":\"ACCOUNT_HOLDER\"}' `
  http://127.0.0.1:4000/users
# → 201 {"user":{"id":"<id>","email":"demo.holder2@balancevault.local","role":"ACCOUNT_HOLDER"}}
```

Role comes from the request here because **an administrator creating a user is
the governed path**; anonymous `/register` can only ever create
`ACCOUNT_HOLDER` (role escalation attempts are invalid bodies).

### 3. Create the holder's account and grant permissions (admin)

```powershell
curl.exe -s -b "$tmp\admin.jar" -H "Content-Type: application/json" `
  -d '{\"accountNumber\":\"DEMO-JOURNEY-ACCOUNT\",\"label\":\"Journey account\",\"currencyCode\":\"INR\",\"kind\":\"CUSTOMER\",\"status\":\"ACTIVE\"}' `
  http://127.0.0.1:4000/accounts
# → 201 { "account": { "id": "<accountId>", ... } }
```

```powershell
foreach ($p in "VIEW","WITHDRAW","TRANSFER") {
  curl.exe -s -b "$tmp\admin.jar" -H "Content-Type: application/json" `
    -d ('{\"userId\":\"<holderId>\",\"accountId\":\"<accountId>\",\"permission\":\"' + $p + '\"}') `
    http://127.0.0.1:4000/account-permissions
}
# → 201 per grant; a duplicate grant is refused (409-class VALIDATION_FAILED); self-grant refused (SELF_GRANT_REFUSED)
```

### 4. Login as ACCOUNT_HOLDER

```powershell
curl.exe -s -c "$tmp\holder.jar" -H "Content-Type: application/json" `
  -d '{\"email\":\"demo.holder2@balancevault.local\",\"password\":\"REDACTED\"}' `
  http://127.0.0.1:4000/login
```

### 5. View authorized accounts and balances (holder)

```powershell
curl.exe -s -b "$tmp\holder.jar" http://127.0.0.1:4000/accounts
# → only the granted account (grant-scoped visibility)
curl.exe -s -b "$tmp\holder.jar" http://127.0.0.1:4000/accounts/<accountId>
# → {"account":{...,"balanceMinor":"0",...}}
```

Also try a foreign account id → the uniform `404 ACCOUNT_NOT_FOUND` envelope
(two-sided truth: no existence leak).

### 6. Deposit through ADMIN authorization (admin; holders cannot deposit — H-2)

```powershell
curl.exe -s -b "$tmp\admin.jar" -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-deposit-0001" `
  -d '{\"amountMinor\":\"250000\",\"currencyCode\":\"INR\",\"description\":\"demo deposit\"}' `
  http://127.0.0.1:4000/accounts/<accountId>/deposits
# → 200 {"status":"SUCCEEDED","journalTransactionId":"<jid>","replayed":false}
```

The same call by the holder → refusal (deposits are ADMIN-only, H-2).

### 7. Withdraw (holder)

```powershell
curl.exe -s -b "$tmp\holder.jar" -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-withdraw-0001" `
  -d '{\"amountMinor\":\"10000\",\"currencyCode\":\"INR\",\"description\":\"demo withdrawal\"}' `
  http://127.0.0.1:4000/accounts/<accountId>/withdrawals
```

Withdrawing more than the balance → `409 INSUFFICIENT_FUNDS` (attempt row
recorded; visible as a refusal line in the statement).

### 8. Transfer between accounts (holder; TRANSFER grant on the source)

```powershell
curl.exe -s -b "$tmp\holder.jar" -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-transfer-0001" `
  -d '{\"sourceAccountId\":\"<accountId>\",\"destinationAccountId\":\"<otherAccountId>\",\"amountMinor\":\"5000\",\"currencyCode\":\"INR\"}' `
  http://127.0.0.1:4000/transfers
```

(`DEMO-COUNTER-ACCOUNT` from the seed works as the destination if you grant
the holder `VIEW` on it first — the destination must be viewable.)

### 9. Statement / transaction history (holder; admin/auditor can view any)

```powershell
curl.exe -s -b "$tmp\holder.jar" "http://127.0.0.1:4000/accounts/<accountId>/statement?limit=50"
# → merged timeline: postings + locked refusals, running balanceAfterMinor, initiator display name
curl.exe -s -b "$tmp\holder.jar" "http://127.0.0.1:4000/transactions/<journalTransactionId>"
# → single transaction with both postings
```

### 10. Idempotency replay + payload binding

```powershell
# Replay the SAME key + SAME body → stored result, no new movement:
curl.exe -s -b "$tmp\holder.jar" -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-withdraw-0001" `
  -d '{\"amountMinor\":\"10000\",\"currencyCode\":\"INR\",\"description\":\"demo withdrawal\"}' `
  http://127.0.0.1:4000/accounts/<accountId>/withdrawals
# → 200 {..."replayed":true}  — balance unchanged

# SAME key + DIFFERENT amount → refused:
curl.exe -s -b "$tmp\holder.jar" -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-withdraw-0001" `
  -d '{\"amountMinor\":\"99999\",\"currencyCode\":\"INR\"}' `
  http://127.0.0.1:4000/accounts/<accountId>/withdrawals
# → 409 {"error":{"code":"KEY_REUSED",...}}  — no movement
```

### 11. Login as AUDITOR

```powershell
curl.exe -s -c "$tmp\auditor.jar" -H "Content-Type: application/json" `
  -d '{\"email\":\"demo.auditor@balancevault.local\",\"password\":\"REDACTED\"}' `
  http://127.0.0.1:4000/login
```

### 12. Audit events (auditor — read-only; admin also allowed)

```powershell
curl.exe -s -b "$tmp\auditor.jar" "http://127.0.0.1:4000/audit/events?limit=50"
# → USER_REGISTERED/USER_CREATED, LOGIN_SUCCEEDED/LOGIN_FAILED, permission_granted/revoked,
#   role_changed, DEPOSIT_POSTED/... refusal rows with reason codes (AUD-001)
```

An auditor attempting any mutation → uniform 404 / refusal (no money movement,
no permission change).

### 13. Reconciliation (auditor/admin)

```powershell
curl.exe -s -b "$tmp\auditor.jar" http://127.0.0.1:4000/reconciliation/summary
# → {"healthy":true,"journalsChecked":n,"conservation":{"conserved":true,...},"violations":[]}
curl.exe -s -b "$tmp\auditor.jar" http://127.0.0.1:4000/reconciliation/accounts/<accountId>
# → storedBalance == derivedBalance, reconciled:true, sequenceReconciled:true
```

## Cleanup

**None required and none provided.** Every step is idempotent-by-key or
naturally idempotent; old fixture accounts from test suites are harmless. If a
future owner ever wants a scoped cleanup, it must be written, inspected and
approved explicitly — never run automatically (per the Phase 3 rules).

## Production note

This runbook is **local-only**. Production has no ADMIN (the first-admin
bootstrap slot is deliberately reserved for the owner's real administrator),
so steps that require an ADMIN cannot be demonstrated there, and the
production deposit journey is documented as
**`BLOCKED — awaiting owner-controlled real-admin bootstrap`** — an
intentional security decision, not a defect. Do not run the bootstrap, do not
create demo administrators, and do not insert transactions into production.
