# Invoicer API keys and MCP

Open **API & MCP** in the app, select the business in the sidebar, and create a named key. The full key is displayed once. Only its SHA-256 hash is stored. Keys grant either read-only or read-and-write access to that business; they cannot create businesses or manage keys. Revoke keys from the same page.

Hosted MCP endpoint: `https://invoicer.phooey.foo/mcp`

Use a Streamable HTTP MCP client supporting `Authorization: Bearer YOUR_API_KEY`. This endpoint uses stateless JSON responses. It does not currently implement OAuth discovery or interactive OAuth authorization. Self-hosted deployments use their own origin plus `/mcp`.

Tools cover business settings, invoice search, detail and PDF downloads, draft creation and updates, customer creation and updates, branding presets, invoice issue/duplicate/archive/restore/void, cumulative payment recording, and share creation/revocation. Mutations use the same validation and optimistic revision checks as REST. Creating a draft does not issue or share it. Recording a payment does not move money. Share links expose an issued invoice to anyone holding the link.

REST uses the same key at `/api/v1/*`. The key selects its business automatically. Dashboard sessions can select another business using `X-Business-Id`; a business key cannot use that header to access a different business. The self-host admin key remains supported for owner operations.

## Deployment

Apply `migrations/0002_businesses.sql` before deploying the new worker. It preserves existing settings, counters, invoices, customers, presets, logos, shares and idempotency records under the `default` business. New businesses start with separate numbering and settings.

Hosted deployments build with `npm run build:hosted`, which produces root-relative assets. The portal owns both `invoicer.phooey.foo` and `getinvoicer.phooey.foo`. The portal must set `INVOICER_ORIGIN` and `INVOICER_MARKETING_ORIGIN`, bind `INVOICER_ASSETS`, and retain the workspace service bindings. Each invoice worker sets `KEY_NAMESPACE` to its workspace ID, `PUBLIC_ORIGIN` to the Invoicer domain, and `BUNDLE_PREFIX` to `/w/WORKSPACE_ID` for public invoice links. `scripts/configure-hosted.mjs` generates these settings from `invoicerOrigin` and `invoicerMarketingOrigin` in the hosted manifest. `scripts/launch-hosted.mjs` configures both production domains.

Finance signs users in through a one-use, browser-bound handoff. Invoicer gets a separate host-only cookie; Finance's cookie is never shared with other subdomains. Old Finance Invoicer navigation redirects to the dedicated domain. Existing workspace-specific public links continue to resolve.
