# Up Bank → Actual Budget Webhook Bridge

This small Node.js service receives Up Bank webhooks and imports the related transactions into your self‑hosted Actual Budget (e.g., on PikaPod) using `@actual-app/api`.

## Features

- __Verifies Up webhook signatures__ via `X-Up-Authenticity-Signature` (HMAC‑SHA256)
- __Fetches full transaction details__ from Up API on each event
- __Imports into Actual__ using `importTransactions()` with `imported_id` set to the Up transaction id (dedupe-friendly)
- __Account mapping__ from Up account → Actual account via `ACCOUNT_MAP`
- Handles `TRANSACTION_CREATED` and `TRANSACTION_SETTLED` by importing/clearing; ignores `TRANSACTION_DELETED` (see Notes)

## Requirements

- Node.js 18+
- Up API Personal Access Token
- Up Webhook Secret (returned when creating a webhook)
- Actual server URL (your PikaPod URL), server password, and Budget Sync ID

## Configure

1) Copy env file and fill values:

```bash
cp .env.example .env
```

Edit `.env`:

- `UP_WEBHOOK_SECRET`: from Up when you create the webhook
- `UP_API_TOKEN`: your Up Personal Access Token
- `ACTUAL_SERVER_URL`: e.g. `https://<your-pod>.pikapod.net`
- `ACTUAL_PASSWORD`: Actual server password (set in the Actual server)
- `ACTUAL_BUDGET_ID`: Sync ID from Actual → Settings → Advanced → Sync ID
- Optional `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` if your budget uses E2EE
- `ACCOUNT_MAP`: JSON mapping from Up account id to Actual account id
- `PORT`: port to run the webhook service (default 8080)
- Optional `AMOUNT_FLIP=true` if your amounts need flipping

2) Install dependencies:

```bash
npm install
```

## Map accounts

- List Actual accounts (requires Actual env vars set):

```bash
npm run list-accounts
```

- List Up accounts (requires `UP_API_TOKEN`):

```bash
npm run list-up-accounts
```

Use the printed ids to fill `ACCOUNT_MAP` in `.env`, e.g.:

```env
ACCOUNT_MAP={"482d7d76-ee91...":"c179c3f4-28a6-..."}
```

## Run

- Dev mode (auto‑reload):

```bash
npm run dev
```

- Prod:

```bash
npm start
```

Health check: `GET /health`

Helper endpoints:

- `GET /actual/accounts` – list Actual accounts
- `GET /up/accounts` – list Up accounts

Webhook endpoint (configure this URL at Up):

- `POST /webhook/up` (content type `application/json`)

Ensure this service is reachable from the public internet (e.g., deployed server, reverse proxy, or a tunnel like Cloudflare Tunnel / ngrok). Up requires HTTPS; use a valid certificate.

## How it works

- The route `POST /webhook/up` uses `express.raw()` to get the raw body for HMAC verification.
- We verify `X-Up-Authenticity-Signature` using `UP_WEBHOOK_SECRET`.
- We parse the event, fetch the transaction via Up API, map the fields, and call `@actual-app/api` `importTransactions()` with `imported_id` set to the Up transaction id.
- Amounts use Up `valueInBaseUnits` (cents). If your sign convention differs, set `AMOUNT_FLIP=true`.
- Cleared is set when Up `status` is `SETTLED`.

## Notes & limitations

- __Deletion__: `TRANSACTION_DELETED` is currently ignored. Actual’s API deletes by Actual transaction id, not the `imported_id`. Implementing deletion would require a search layer to look up transactions by `imported_id`.
- __Transfers & categories__: We don’t set categories or handle transfers; your rules in Actual can categorize on import. Add logic if desired.
- __TLS / certs__: If your Actual server uses custom CA, see `Self-Signed Https Certificates` in the Actual API docs and set `NODE_EXTRA_CA_CERTS`.

## File overview

- `src/index.js` – Express server, webhook route, helper endpoints
- `src/config.js` – env loading & validation
- `src/up.js` – Up API client, signature verification, mapping
- `src/actual.js` – Actual API client & import
- `scripts/list-accounts.js` – list Actual accounts
- `scripts/list-up-accounts.js` – list Up accounts

## References

- Up API – Webhooks security and payload: https://developer.up.com.au/#webhooks
- Actual API – Using the API: https://actualbudget.org/docs/api/
- Actual API – Reference (Transactions): https://actualbudget.org/docs/api/reference
