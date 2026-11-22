# Hosted beta operations

For the existing Phooey Cloudflare account, start with the [three-step production launch](cloudflare-quickstart.md).

## Deployment model

The commercial portal and workspace Workers are separate from the personal deployment. The portal holds customer identity, subscription state, sign-in challenges, and the workspace registry in CONTROL. Each provisioned workspace has a distinct ledger D1 database, private R2 bucket, queue, hostname, and encryption key. The paid beta uses a pre-provisioned pool. A workspace is reserved before opening checkout. An occupied slot stays assigned on cancellation. Never assign an existing customer's ledger or bucket to another person. Provision additional empty slots as demand grows.

The portal serves the public site on getfinance.phooey.foo. The app domain finance.phooey.foo hosts sign-in, provider callbacks, account, billing, Finance and Invoicer. Its root sends signed-out visitors to the marketing site. For signed-in users, the portal selects their assigned workspace and forwards requests through its private service binding while keeping the browser on finance.phooey.foo. The workspace independently checks the app session, owner and subscription. Existing workspace API and mobile URLs remain available, and public invoice links retain their workspace-specific address for signed-out recipients. Invoicer has a private Worker and D1 database per workspace. Its service binding has no public route.

The release pins Melody Auth to commit `da208cd90545b7f5b42891d7e3dd83f91c5e984f`. The profile patch carries Apple’s verified-email claim and the underlying Google or Apple account ID into Finance. Reuse the same Google client and Apple Services ID when migrating existing customers. Finance matches the provider subject to the existing ledger. The upstream checkout and its MIT license are under `.private/launch/melody-source` after installation.

## Set up a commercial environment

Start in Stripe test mode and a dedicated Cloudflare environment. Use Node 24.11+ and run npm ci and npm run check. The build bundles both Worker entry points. The default deployment command still targets the existing self-hosted edition.

1. Create the commercial D1 database named phooey-hosted-control. For each beta slot such as beta01, create D1 phooey-hosted-beta01-ledger, private R2 bucket phooey-hosted-beta01-files, and Queue phooey-hosted-beta01-jobs. Use verified custom hostnames distinct from the existing personal domain.
2. Deploy the dedicated Melody Auth Worker using the production quickstart. The portal reaches it through the MELODY service binding. Only the Finance app domain serves its sign-in UI. The portal completes the PKCE exchange through the private binding.
3. Create a Stripe recurring USD $29.00 annual price. Enable the customer portal with cancellation at period end. For Stripe Tax, configure registrations and product tax codes, then set automaticTax to true in the private manifest. Configure Stripe branding, business identity, receipt email, taxes that apply to the business, and support details. The bank service has no Stripe price in Phooey.
4. Create a new Invoicer D1 database for each slot. Build its private Worker assets with npm ci and npm run build:hosted inside invoicer. The ordinary npm run build there produces the standalone self-hosted edition.
5. Create a private resource manifest as below, then run npm run hosted:configure -- .private/hosted-resources.json. Generated configs contain resource IDs, origins, and public client IDs. Install runtime secrets separately.

```json
{
  "portalOrigin":"https://getfinance.phooey.foo",
  "appOrigin":"https://finance.phooey.foo",
  "melodyClient":"phooey-finance",
  "stripePrice":"your-annual-price-id",
  "supportEmail":"your-real-support-mailbox@example.com",
  "controlDatabaseId":"your-control-database-uuid",
  "slots":[{"id":"beta01","origin":"https://beta01.books.example.com","databaseId":"your-ledger-database-uuid","invoiceDatabaseId":"your-invoice-database-uuid"}]
}
```

From the repository root, run the following with the generated configs. Use local flags or separate staging resources for rehearsals. Register a slot only after its bindings and migrations are ready.

```sh
npx wrangler d1 migrations apply CONTROL --remote --config .private/hosted/portal.json
npx wrangler d1 migrations apply DB --remote --config .private/hosted/beta01.json
npx wrangler d1 migrations apply DB --remote --config .private/hosted/beta01-invoicer.json
npx wrangler d1 execute CONTROL --remote --config .private/hosted/portal.json --file .private/hosted/register.sql
```

Install STRIPE_SECRET and STRIPE_WEBHOOK_SECRET on the portal. Install a separate base64 32-byte ENCRYPTION_KEY on each workspace. Generate a per-slot random secret with openssl rand -hex 32. Install the same value as ADMIN_KEY on its private Invoicer Worker and INVOICER_KEY on the matching Finance workspace Worker. Deploy the private Invoicer Worker first, then its workspace, then the portal. Use the generated configuration for every deployment. Moving finance.phooey.foo from an existing personal Worker requires an explicit domain cutover and an alternative address for the personal deployment.

For self-hosted Finance, set ADMIN_KEY to a random secret of at least 32 characters. It takes precedence over the legacy password settings. Rotating the key invalidates existing Finance browser sessions. Set ENCRYPTION_KEY separately for bank credentials. Invoicer uses the same ADMIN_KEY convention when deployed independently.

The iPhone target is ios/PhooeyFinance.xcodeproj. Its system-browser sign-in uses a one-use code bound to the app's verifier and the subscriber's workspace. Choose an Apple development team and provision the bundle identifier before archiving. The app has no App Store listing until it is signed, submitted and released.

Point the Stripe webhook at `https://finance.phooey.foo/cloud/webhook` for checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, and invoice.payment_failed. Use a separate signing secret per environment. Handlers verify the signed body and read the current subscription at Stripe. Repeated and out-of-order deliveries can be retried safely. Monitor failed webhook deliveries in Stripe.

## Release rehearsal

- Use two separate customer identities and independent provisioned slots. Check dashboard, workbook, attachments, exports, MCP tokens, background jobs, Google revocation, and subscription expiry. Complete a Stripe test renewal and cancellation. Verify support email delivery and provider-hosted recovery/passkey flows.
- Compare ledger totals, refunds, splits, excluded personal allocations, transfers, and quarterly estimates with the workbook. Try sorting, pasting, disconnecting Google, denying consent, and saving an obsolete revision. Check Apps Script quotas and try a 5,000-row institution export with realistic notes.
- Restore a staging workspace to a fresh ledger from its database backup and copy its private file bucket to a new private bucket. Restore its encryption key in protected configuration. Compare account totals, receipt bytes, and the tax profile before reconnecting providers. Use a separate staging control database and disable schedules during the rehearsal. A JSON export covers supported ledger records and excludes attachment binaries and provider credentials.
- Confirm the business operator name, refund process, sales tax handling, privacy terms, support address and deletion responsibilities before enabling live checkout. Handle a deletion request by verifying ownership, disconnecting providers, cancelling billing as appropriate, revoking all sessions and grants, and deleting that workspace's financial records and files. Record only the minimum details required for billing and the deletion receipt. Never reuse its populated resources.
- Alert on delayed feeds, repeated refresh failures, webhook delivery failures, and exhausted beta capacity. The Workers log fixed event names and slot labels. Set an optional OPS_ALERT_URL HTTPS webhook on portal and workspace Workers to deliver these operational alerts. Repeat alerts are limited to one per event and slot every six hours. Review failed jobs, last successful workbook refresh, Stripe event delivery, and support requests daily during the pilot. On a provider outage, preserve pending drafts, pause new sync attempts if appropriate, and resume with the existing revision/request key.

Run hosted/reports.sql against CONTROL to review activation and returns. Business milestones, recruitment materials and target economics are in business-launch.md. Verify live provider approvals, a real institution import with the owner's consent, and the public listing separately from local automated tests.

## Existing Tiller workbooks

The standalone connector at /business/tiller-connect/ is distributed with the public site. It uses an owner-created read-only Phooey token and Google Apps Script's native Sheets permissions. A copy of an existing Tiller Google Sheet retains the owner's dashboards, formula references, category tags and original tax assumptions. The connector source and manifest are in public/business/tiller-connect. Downloadable releases are packaged during the build. The setup page documents the cutover, mapping, supported AutoCat rules and optional daily trigger. No Marketplace listing is required for this installation.

## Foundation templates

The hosted dashboard opens on Foundation. At /foundation-preview visitors can explore the same views with the example workbook data. Budget targets persist by year, month, currency and category, and are included in portable backups. The annual price stays at $29 with optional bank feeds purchased directly from SimpleFIN.

The native Google Sheets master is linked from /business/template/. Only fictional examples belong in this public master. The blank-workbook and optional report installation code lives in public/business/template/Foundation.gs. The connector bundle includes this file so existing Tiller users can add Business Dashboard or Quarterly Earnings without replacing a report they already have.

Hosted workbooks retain their transaction feed and edit staging. A refresh adds missing Foundation report tabs and marks them as managed using sheet developer metadata. If a customer's custom tab already uses a report's name or reserved ID, sync preserves it. Manage targets and categorization in the signed-in Foundation workspace. Native template copies calculate directly from their own source tabs.
