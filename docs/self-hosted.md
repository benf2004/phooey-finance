# Self-host Finance and Invoicer

The combined edition runs Finance at `/` and Invoicer at `/invoicer/` on one Cloudflare Worker. Sign in once with one `ADMIN_KEY`; either app's sign-out ends that session for both apps. No hosted subscription, Melody, social sign-in, email verification, passkeys, or account provisioning is required.

Both editions use the same application components and server services. Updates to those features are included automatically when you rebuild.

| App | Included features |
| --- | --- |
| Finance | Spreadsheet and table editing, inline row creation, calendars, accounts, categories, tags, rules, split transactions, transfers, attachments, reports, budgets, tax planning, bank sync with date selection and job progress, CSV import/export, backup/restore, preferences, and MCP |
| Invoicer | Multiple businesses, invoice editor and custom labels, templates, branding presets, logos, customers, PDF previews/downloads, invoice history and filters, draft/issue/payment/void/archive/restore/duplicate actions, REST API examples and reference, business-scoped API keys, and MCP |

Finance and Invoicer keep separate databases. Combining their access does not copy invoice payments into the Finance ledger. The native iPhone app's hosted sign-in flow is separate; both self-hosted web apps work in mobile browsers.

## Local setup

From the repository root, using Node 24.11 or newer:

```sh
npm ci
npm --prefix invoicer ci
npm run setup:local
npm run migrate:self-hosted:local
npm run dev:self-hosted
```

Read `ADMIN_KEY` from the ignored `.dev.vars` file and use it on the Finance sign-in screen. The setup command preserves an existing `.dev.vars`; older password-based installations must add a random `ADMIN_KEY` of at least 32 characters. Keep the existing `ENCRYPTION_KEY` when upgrading an installation with bank connections.

The development command builds both frontends and starts Wrangler with local D1, R2 and Queues. Re-run it after frontend changes. It never applies remote migrations or deploys.

## Deploy

1. Install dependencies as above and authenticate with `npx wrangler login`.
2. Create the resources, unless reusing your existing installation:

   ```sh
   npx wrangler d1 create phooey-finance
   npx wrangler d1 create invoicer
   npx wrangler r2 bucket create phooey-finance-files
   npx wrangler queues create phooey-finance-jobs
   ```

3. In `wrangler.self-hosted.jsonc`, replace both placeholder database IDs with the returned IDs. `DB` is Finance; `INVOICER_DB` is Invoicer. Update the Worker name, resource names, and `SOURCE_URL` if needed. This configuration contains no production database IDs or custom domains.
4. Generate the secrets and install them on this Worker:

   ```sh
   node scripts/setup-production.mjs
   npx wrangler secret bulk .private/production-secrets.json --config wrangler.self-hosted.jsonc
   ```

   `ADMIN_KEY` is the only sign-in credential. `ENCRYPTION_KEY` is a separate server encryption key for bank connections, not another login. Store the generated access file in your password manager and back up the encryption key.
5. Build, apply migrations to both databases, and deploy:

   ```sh
   npm run deploy:self-hosted
   ```

Open the printed Worker URL, sign in, then use the Finance/Invoicer navigation links. A custom domain can be added to this Worker. Use Workers Paid for imports and server-side PDF rendering.

Configure the Finance R2 lifecycle rules described in the [main deployment guide](../README.md#deploy-to-cloudflare). Scheduled bank synchronization, queue processing and interrupted-job recovery are included in this configuration.

## Existing installations

Back up both D1 databases and Finance's R2 data before switching. Point `DB` at the existing Finance database and `INVOICER_DB` at the existing Invoicer database; no data export/import is required. Use the existing R2 bucket and queue, keep the original encryption key, and apply both apps' migrations through `npm run deploy:self-hosted`. The original migrations preserve records and Invoicer's existing business data and numbering.

For an existing Finance Worker, keep its name and routes in the new configuration so the deployment replaces that Worker. If choosing a new Worker name, move queue ownership and disable the old scheduled Worker before enabling the replacement; Cloudflare allows only one consumer per queue. Do not leave two active scheduled Finance deployments syncing the same database.

Existing Invoicer integrations need the new `/invoicer` URL prefix when moved into this bundle. Business API keys remain stored in the Invoicer database. Finance OAuth clients using a different origin must reconnect. The two standalone deployments remain supported with their existing configuration files and build commands.

## API and MCP

| Endpoint | Authentication |
| --- | --- |
| `/api/*` | Shared admin browser session |
| `/mcp` | Admin bearer key, scoped Finance token from Settings, or the existing MCP OAuth consent flow |
| `/invoicer/api/v1/*` | Admin session, admin bearer key, or business-scoped API key |
| `/invoicer/mcp` | Admin bearer key or business-scoped API key |

The same admin secret can authenticate both MCP endpoints with `Authorization: Bearer YOUR_ADMIN_KEY`. No additional login credentials are required. The optional MCP OAuth flow is integration authorization and does not require an external identity service. Scoped tokens remain available for limiting integrations to the access they need.

For Invoicer examples set `INVOICER_URL` to `https://YOUR-DOMAIN/invoicer`, including the prefix. API reference links, font loading, PDF previews and downloads stay on your installation. Standalone Invoicer can optionally show a Finance link by setting `VITE_FINANCE_URL` to your Finance URL when building.

## Key rotation and verification

```sh
npx wrangler secret put ADMIN_KEY --config wrangler.self-hosted.jsonc
```

Rotating the key invalidates the shared browser sessions and old admin bearer key. Revoke integration keys separately inside each app. Do not rotate `ENCRYPTION_KEY` as part of sign-in recovery: existing bank connection data needs its original value.

```sh
npm run check
```

This typechecks both applications, builds standalone/hosted Finance and the self-hosted bundle, then runs both test suites. The bundle tests exercise real application handlers and SQLite migrations, shared sign-in/sign-out and key rotation, cross-origin protection, business isolation, PDF generation, prefixed assets/references and both MCP servers. The existing Miniflare integration tests also need permission to open local server ports.
