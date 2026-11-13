# Local setup and n8n connection

## 1. Start the dashboard

Use Node.js 22.17 or newer with `node:sqlite` available. Run `npm install`, then `npm run dev`, and open http://localhost:3002. Windows PowerShell users can use `npm.cmd`.

Create the first owner account on the setup screen. Add staff through the account button. There is no default production password. SQLite migrations apply automatically to the private `.local/access.sqlite` database.

To generate screenshots without n8n or Gmail, run `npx playwright install chromium` and `npm run screenshots`. The command uses a disposable demonstration workspace and leaves your real data alone.

## 2. Prepare n8n

Run local n8n at http://localhost:5678, for example through Docker, using a version that supports Data Tables. Import `workflow/appointments.updated.json` as an **inactive** workflow.

The public export has placeholder table references and no Gmail credential binding. Create the four tables described in [workflow/table-schema.json](../workflow/table-schema.json):

- `appointments`: booking details, private management token, version, and notification state.
- `appointment_system_lock`: shared calendar/dispatch lock.
- `appointment_operator_keys`: hashed server authorization key.
- `appointment_audit_log`: booking audit records.

n8n supplies its own `id`, `createdAt`, and `updatedAt` fields; do not add those manually. Select your newly created table in every matching Data Table node. Search the export for `REPLACE_WITH_` to locate required bindings.

Seed exactly one row in `appointment_system_lock`: `lock_name` = `calendar`, `owner` = an empty string, and `expires_at` = `2000-01-01T00:00:00.000Z`.

## 3. Connect the operator API

Start the dashboard once so it creates its private `.local/operator-token`. Run:

```powershell
npm run operator:hash
```

Copy the printed **hash** into n8n's `appointment_operator_keys` table: `key_name` = `dashboard`, `token_hash` = the SHA-256 value. The raw token stays private in the dashboard data directory.

The app sends public requests to `/webhook/appointments-api`. Signed-in owner/staff operations and the shared calendar use `/webhook/appointments-operator-api`. Keep both paths when importing.

## 4. Connect Gmail and activate

Select your own Gmail OAuth2 credential in **Gmail appointment email**. Configure Google OAuth using n8n's displayed redirect URL. Follow the official [n8n Google OAuth credential instructions](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/).

Review every placeholder and table binding, then publish/activate the workflow. Its timezone is **Asia/Manila** and its schedule checks due notifications every minute.

Choose **Check connection** in the dashboard. The check stops at request validation; it creates no booking and sends no email. It does not verify Gmail delivery.

Use `demo@example.test` for simulated email delivery. Only use an inbox you control for an intentional real test. Late reminders are skipped; cancellation stops remaining reminders.

## 5. Optional receipt email sender

Printable receipts work after a payment/refund is recorded. Receipt email requires the separate sender; recording money alone never emails a receipt.

Set `APPOINTMENTS_N8N_API_KEY` privately in your environment and `APPOINTMENTS_N8N_WORKFLOW_ID` to your imported appointment workflow's ID. Review the plan, then install:

```powershell
node scripts/install-receipt-sender.cjs
node scripts/install-receipt-sender.cjs --apply
```

The installer reuses your appointment Gmail credential and creates an authenticated dashboard callback credential. n8n in Docker must reach `http://host.docker.internal:3002/api/receipt-emails`; keep the dashboard running. Preserve its private installation journal and inspect uncertain outcomes before retrying.

## Optional configuration

Set environment variables before starting the server:

```powershell
$env:PORT = '3002'
$env:APPOINTMENTS_API_URL = 'http://localhost:5678/webhook/appointments-api'
$env:APPOINTMENTS_OPERATOR_API_URL = 'http://localhost:5678/webhook/appointments-operator-api'
# Optional separate private account/client/payment store:
$env:APPOINTMENTS_DATA_DIR = 'C:\private\appoint-data'
npm.cmd run dev
```

A different data directory has its own accounts and operator token. Seed that installation's matching hash in n8n.

## Backups and hosting boundaries

Preserve `.local/access.sqlite`, `.local/operator-token`, the receipt sender's private journal, and your n8n data volume together. These files are ignored by Git.

The server binds to loopback and is intended for local use. Static `dist/` hosting does not supply authenticated APIs or automation. Keep the dashboard, n8n, and computer running for scheduled reminders.
