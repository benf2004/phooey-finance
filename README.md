# Phooey Finance

A self-hosted, AGPL finance dashboard for one administrator. Built with React, TypeScript, Hono and Cloudflare Workers, D1, R2 and Queues. No spreadsheet dependency, analytics, or AI service required.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/benf2004/phooey-finance)

Follow the [deployment steps](#deploy-to-cloudflare) to configure resources, secrets, and database migrations.

- Bank balances and transactions through SimpleFIN, plus manual accounts and CSV imports.
- Search, combined filters, saved views, bulk categorization, split transactions, transfers and edit history.
- Ordered categorization rules with previews; manual edits survive later syncs.
- Cash flow and spending reports, separated by currency.
- Quarterly federal and state tax estimates with editable brackets, flat state rates, deductions, withholding, self-employment tax and payment history.
- Built-in MCP server with OAuth PKCE, scoped access tokens and audited writes.
- CSV exports, portable JSON backup/restore and downloadable application source.

## Run locally

Use Node 24.11+ (the repository includes `.nvmrc`).

```sh
npm ci
npm run setup:local
npm run db:migrate
npm run dev
```

The setup command generates a local admin password and prints it once. Secrets live in ignored `.dev.vars`. Open the URL printed by Vite. Local D1, R2 and Queues run under `.wrangler/`; they do not use production data.

Optional: `npm run seed:demo` loads clearly labeled example accounts and transactions into the **local** database. Never seed production. The server is still protected by the local admin login.

## Deploy to Cloudflare

Workers Paid is the supported deployment target. Imports, restore batches, bulk edits and password hashing rely on its CPU and D1 query limits. Cloudflare hosting and the optional SimpleFIN service have separate costs; the application itself is free software.

1. Sign in with `npx wrangler login`.
2. Create your own resources (names can be changed):

   ```sh
   npx wrangler d1 create phooey-finance
   npx wrangler r2 bucket create phooey-finance-files
   npx wrangler queues create phooey-finance-jobs
   ```

3. In `wrangler.jsonc`, set **`env.production.d1_databases[0].database_id`** to your database ID. The checked-in production ID belongs to the original deployment; forks must replace it. If changing resource names, update the production bindings as well. The top-level placeholder ID is deliberately used only for local development. Set `SOURCE_URL` to your source repository.
4. Generate separate production credentials and install them:

   ```sh
   node scripts/setup-production.mjs
   npx wrangler secret bulk .private/production-secrets.json --env production
   npm run db:migrate:production
   npm run deploy
   ```

5. Read your login in `.private/production-access.txt`. Save it in your password manager. Keep `ENCRYPTION_KEY` securely backed up; it decrypts the SimpleFIN access URL. These files are ignored and excluded from the source download.
6. Configure an R2 lifecycle rule to delete the `exports/` prefix after one day and the `sync/` prefix after seven days. Do not expire `imports/`: failed imports need their staging files to resume. Export download access expires after 24 hours even before physical cleanup.

The production environment uses the same Worker name, `phooey-finance`. `npm run deploy` builds with `CLOUDFLARE_ENV=production`; Wrangler then uses Vite's generated deployment configuration. The twice-daily scheduled trigger checks for new bank data and recovers interrupted jobs. No demo financial data or local secrets are deployed.

## First use

1. Add a manual account or connect a SimpleFIN setup token in Settings, then choose which accounts to import. Nothing is selected automatically.
2. Classify connected account types in Accounts. SimpleFIN does not provide reliable account types, so new accounts start as **Other** and are excluded from cash-on-hand until classified.
3. Create your categories; new installations start with none. Choose tax treatments for business income and expenses, then categorize transactions.
4. Add matching rules for future imports/syncs. Preview and explicitly apply rules to existing eligible transactions.
5. Configure the annual tax plan and state rates. Save the plan to update the dashboard. Record estimated payments separately; associating a payment with a bank transaction is supported by the API/MCP.
6. Connect an MCP client using the URL shown in Settings, or create a scoped personal access token.

See [architecture](docs/architecture.md), [MCP](docs/mcp.md), [tax model](docs/taxes.md), and [backup/recovery](docs/operations.md).

## Verify and develop

```sh
npm run check        # typecheck, build current Worker, then all tests
npm run cf:types     # regenerate Cloudflare bindings after config changes
npm audit
```

Tests execute the built Worker with real local D1/R2 via Miniflare, exercise OAuth and MCP scope boundaries, and cover tax calculations, CSV handling, retries, sync ownership, chunked jobs and restore. Provider fixtures are deterministic; they do not access a user's bank. A live smoke test against SimpleFIN's official demo service also passed. Run it explicitly with `SIMPLEFIN_LIVE=1 npm test -- tests/jobs.test.ts`; ordinary CI does not contact SimpleFIN. A real institution connection must be configured by its owner.

The frontend uses a system font and compact tables; tax inputs and longer explanations use disclosures. Financial calculations and validation live in shared modules. Server services are shared by HTTP and MCP.

## License

AGPL-3.0-only; see [LICENSE](LICENSE). Each build serves its corresponding source at `/source.tar.gz`, including build instructions and excluding secrets/data. The repository link is also available in Settings. SimpleFIN and Cloudflare are independent services and are not bundled or relicensed by this project.
