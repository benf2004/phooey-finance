# Invoicer

A small, open-source invoice workspace for your businesses, hosted entirely on your own Cloudflare account. Create branded invoices in the dashboard or generate PDFs on demand through a REST API. The self-hosted version uses the same editor, features, REST API and MCP server as the hosted edition, with one admin key.

To run Finance and Invoicer together with a shared admin-key sign-in, follow the [combined self-hosting guide](../docs/self-hosted.md). The instructions below deploy Invoicer independently.

**Multiple businesses, editable invoices, and business-scoped API keys on Cloudflare Workers + D1.** AGPL-3.0-only licensed; bundled fonts have their own OFL license.

## What it does

- Invoice-shaped editor with immediate totals and a real PDF preview, including mobile browsers without native PDF support.
- Classic and Modern templates, your logo, accent color, Noto Sans/Serif/Mono, editable labels, optional sections, custom fields, and A4/Letter.
- Named branding presets with a default, reusable customers, business settings, search/status filters, and paginated invoice history.
- Draft → issued → paid/void, manual cumulative payments, duplication, archiving and restoration. Issued details are immutable snapshots.
- Optional, revocable customer links for viewing, printing and downloading. A new link invalidates the previous link; archiving revokes links permanently.
- Bearer-authenticated REST API with OpenAPI 3.1, creation idempotency, revision checks and an entirely stateless PDF endpoint.

Payment processing, email delivery, reminders, receipt documents, freeform layout design and multiple user accounts are outside this version. Manual payment recording, multiple businesses and MCP are included. Finance provides bookkeeping and accounting reports in the combined deployment.

## Local development

Use Node.js 22 LTS (22.13 or newer) or Node.js 24+ and npm. Dependencies are locked in `package-lock.json`.

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Set `ADMIN_KEY` in `.dev.vars` to a **new cryptographically random key of at least 32 characters**. A password manager can generate it. The file is ignored by Git. Do not reuse a production key for local development.

```sh
npm run db:migrate:local
npm run dev
```

Open the URL printed by Wrangler (normally `http://localhost:8787`) and sign in with your key. Add your business details in Settings, optionally create a branding preset, then create an invoice.

For frontend hot reload, leave Wrangler running and start `npm run dev:ui` in another terminal; Vite proxies API/auth requests to the local Worker.

### Disposable preview

```sh
npm run build
node scripts/preview.mjs
```

This starts `http://127.0.0.1:8788` with its own local D1 database and generated key in `.wrangler/preview/.dev.vars`. It never uses a remote database. Use that key to sign in; this preview is separate from your normal local database. Stop the preview before deleting its `.wrangler/preview` directory.

## Deploy to your own Cloudflare account

No external rendering service, R2 bucket, custom domain, Cloudflare Access or email provider is required. Workers Paid is recommended for server-side PDF generation; see the performance note below.

1. Authenticate Wrangler to your Cloudflare account with `npx wrangler login`.
2. Run `npx wrangler d1 create invoicer`.
3. Copy the returned `database_id` into the `DB` entry in `wrangler.jsonc`. Choose a globally suitable Worker name if `invoicer` is taken.
4. Run `npm run build` and `npm run db:migrate:remote`.
5. Run `npx wrangler secret put ADMIN_KEY` and enter a new random key at the secure prompt. If Wrangler asks to create the Worker, allow it. Never place the key in the configuration or command arguments.
6. Run `npm run deploy` and open the printed workers.dev URL. Set your business details and branding after signing in.

Later deployments apply pending migrations before publishing the Worker. Review migration changes and back up D1 before upgrading.

For staging, create a **separate** D1 database, put its ID in `env.staging.d1_databases`, and use `--env staging` for migrations, secrets and deployment. Example:

```sh
npx wrangler d1 migrations apply DB --remote --env staging
npx wrangler secret put ADMIN_KEY --env staging
npm run build
npx wrangler deploy --env staging
```

The repository contains configuration and migrations but does not deploy automatically or include any production credentials.

## REST API

Read the interactive-facing reference at `/api/v1/docs` or download `/api/v1/openapi.json`. Data endpoints accept `Authorization: Bearer YOUR_API_KEY`. Create a business-scoped key from **API & MCP** in the dashboard. The self-hosted admin key remains supported for owner operations. The dashboard uses the same operations through a protected session.

Configure these environment variables locally, without committing them or putting the key directly into command text:

```sh
# INVOICER_URL: your deployed app's origin
# INVOICER_API_KEY: a read-and-write business API key
```

Generate a PDF **without writing an invoice or allocating a number**:

```sh
curl "$INVOICER_URL/api/v1/render" \
  -H "Authorization: Bearer $INVOICER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @docs/example-invoice.json \
  --output invoice.pdf
```

Save and immediately issue an invoice:

```sh
curl "$INVOICER_URL/api/v1/invoices" \
  -H "Authorization: Bearer $INVOICER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1042-invoice' \
  --data @docs/example-invoice.json
```

The example includes `status: "issued"`; omit it or use `draft` to create a draft. Rendering ignores status and does not assign a number. Both modes accept the same invoice input.

| Endpoint | Purpose |
| --- | --- |
| `POST /render` | Return a PDF without persistence. |
| `GET/POST /invoices` | List/create invoices. |
| `GET/PUT /invoices/{id}` | Read/replace an active draft. |
| `GET /invoices/{id}/pdf` | Download the current PDF. |
| `POST /invoices/{id}/issue` | Freeze and number a draft. |
| `POST /invoices/{id}/duplicate` | Create an unpaid, unnumbered draft from a snapshot. |
| `POST /invoices/{id}/payment` | Set cumulative `amountPaid`, not an incremental payment. |
| `POST /invoices/{id}/void` | Mark an issued/paid invoice void; preserve its details. |
| `POST /invoices/{id}/archive` or `/restore` | Archive/restore a record. |
| `POST/DELETE /invoices/{id}/share` | Generate/rotate or revoke a customer link. |
| `GET/POST /customers`, `PUT/DELETE /customers/{id}` | Manage customer details; deletion archives the directory entry. |
| `GET/POST /presets`, `PUT/DELETE /presets/{id}` | Manage styles; deletion clears a default but preserves invoice snapshots. |
| `GET/PUT /settings` | Manage business defaults and numbering. |
| `POST /assets`, `GET /assets/{id}` | Upload/read an immutable PNG/JPEG logo. |

All paths in the table are relative to `/api/v1`. Updates and lifecycle actions require the current `revision` in the JSON body. Settings updates use `{ "revision": 1, "settings": { ... } }`. Customer updates use `{ "revision": 1, "party": { ... } }`. Payment uses `{ "revision": 1, "amountPaid": "125.00" }`.

Lists accept `page` and `limit` (up to 100). Invoices also accept `q`, `status=all|draft|issued|paid|void|overdue`, and `archived=true`. Errors have `{ "error": { "code", "message", "details"? } }`; stale revisions and reused invoice numbers return 409.

Creation idempotency keys are kept in D1. Identical retries return the same invoice (200 and `Idempotency-Replayed: true`); changed input with the same key returns 409. Choose a new key for each intended invoice.

### Defaults, branding and snapshots

Business defaults apply first, then the selected `presetId` (or the default preset), then inline overrides. `customerId` supplies billing details; inline `billTo` fields override them. An invoice always saves resolved details, never live references. `PUT` replaces a draft: send a complete document, rather than a patch.

A logo can be `branding.logoAssetId` from `/assets` or `branding.logoData`, a PNG/JPEG base64 data URL. Remote logo URLs are never fetched. Uploads require actual PNG/JPEG bytes, at most 256 KiB and 2048 × 2048 pixels. The UI resizes before uploading. Assets are immutable and retained so old invoices keep their logos.

Automatic numbers are assigned only when issued. D1's trigger allocates and increments the counter atomically; a unique constraint prevents duplicate numbers. Explicit numbers do not consume the counter. The configurable counter can advance but cannot move backward. If an explicit number collides with a future automatic number, advance the counter in Settings.

### Money and document limits

Quantities and monetary inputs are decimal strings, up to six decimal places. Each line rounds half-up to the currency's minor unit. Totals are integer minor units:

1. Sum rounded line amounts.
2. Subtract a fixed/percentage discount.
3. Add fixed/percentage tax calculated on the discounted subtotal.
4. Add shipping, then subtract cumulative amount paid.

Negative inputs, discounts above subtotal, percentages above 100%, and overpayment are rejected. Zero-value issued invoices have zero balance and therefore show as paid. Currency formatting uses ISO currency codes to avoid ambiguous symbols. Overdue means unpaid, issued, with a due date earlier than today in UTC; it is a derived filter, not a stored state.

JSON bodies are capped at 1 MiB, line items at 200, custom fields at 20. Large values are limited to keep integer totals safe. Dates are calendar dates, not timestamps. PDF text supports Latin-script text and accented characters; unsupported glyphs return a clear error instead of disappearing. Labels can be translated manually; UI and customer controls remain English.

## Security and operations

- The Worker fails closed if `ADMIN_KEY` is missing or shorter than 32 characters.
- Dashboard sessions last 12 hours, use HttpOnly/SameSite cookies and Secure on HTTPS, and store only token hashes in D1. Mutations require a matching Origin and CSRF token.
- Admin keys are checked with constant-time digest comparison. Failed logins are throttled per hashed IP: eight attempts in ten minutes.
- Rotating `ADMIN_KEY` via `npx wrangler secret put ADMIN_KEY` invalidates existing sessions on their next request. Clients using the owner key must use the new key; revoke business API keys separately in API & MCP.
- Customer URLs are bearer capabilities: anyone holding a link can read that invoice. Only a token hash is stored. Revocation also blocks PDF downloads. Restoring an archived invoice does not revive old links.
- Customer and API responses use `no-store`, `noindex` and `no-referrer`. No third-party page assets, analytics or rendering requests are used. The bundled PDF viewer does not execute PDF JavaScript.
- Worker error logs omit request bodies and identifiers. Cloudflare's request metadata may include share URL paths; restrict access to platform logs and database exports.
- `GET /health` checks D1 availability. Use Workers observability for errors and actual production CPU duration.

### Backup and restore

```sh
npx wrangler d1 export DB --remote --output backup.sql
```

Keep backups private: they contain invoice/customer details, session hashes and branding. The admin secret is not part of a D1 export. Restore an export into a **new empty database** with `wrangler d1 execute NEW_DATABASE_NAME --remote --file backup.sql`, then point the Worker binding at its returned database ID and deploy. Keep the old database until the restored app has been verified. D1 Time Travel is also available subject to your account's retention period.

### PDF performance

PDFs are generated directly with pdf-lib/fontkit and embedded Noto fonts. Browser preview uses the same renderer, with PDF.js for display. PDFs are generated on demand, not stored in D1.

A local one-line API render took approximately **46–53 ms** in workerd. The 8–10-page stress fixtures took approximately **219–629 ms wall time** and **227–685 ms local Node process CPU**, depending on font and template. These are development-machine measurements, not Cloudflare production CPU measurements. `X-PDF-Render-Ms`/`Server-Timing` report render duration; inspect actual CPU in Workers observability after deployment.

Cloudflare currently documents a [10 ms HTTP CPU allowance on Workers Free](https://developers.cloudflare.com/workers/platform/limits/). **This app does not claim Free-plan PDF compatibility. Use Workers Paid for reliable API and customer PDF rendering**, then measure with representative invoices. No browser-service fee is involved.

## Validation

```sh
npm run types
npm run typecheck
npm test
npm run build
npm run test:integration
npm run check:deploy
```

The integration suite provisions a fresh temporary local database and Worker, tests auth/CSRF, concurrency, state transitions, snapshot isolation, sharing and stateless generation, then cleans up. It requires an available localhost port 8791 and permission to run workerd. It never deploys or uses a remote binding. PDF tests create ignored fixtures in `test-results/pdfs` for visual inspection.

## License and acknowledgments

Application source: [AGPL-3.0-only](LICENSE). [Minvoice](https://github.com/ddyy/minvoice) inspired the single-business Workers/D1 approach; [worker-generate-invoice-pdf](https://github.com/adamschwartz/worker-generate-invoice-pdf) inspired on-demand generation. This implementation does not copy Invoice Generator's source, branding or assets, and does not include Minvoice payment or email code.

Bundled Noto font files: [SIL Open Font License](public/fonts/OFL.txt), sourced from the [Noto upstream repository](https://github.com/notofonts/noto-fonts). See [dependency notices](THIRD_PARTY_NOTICES.md). Maintainers can refresh the bundled fonts with `npm run fonts`; users do not need network access to a font provider at runtime.

## Multiple businesses and MCP

Create and switch businesses from the sidebar. Each business has independent customers, branding, settings, invoice numbering, and API keys. See [MCP and deployment notes](docs/mcp.md) for the new migration, scoped credentials, and dedicated hosted domains.
