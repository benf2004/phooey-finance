# MCP server

Hosted endpoint: `https://finance.phooey.foo/mcp`. Transport: Streamable HTTP. Self-hosted installations use `https://YOUR-WORKER.workers.dev/mcp`. The dashboard Settings page shows the exact URL.

The hosted endpoint routes OAuth and personal access tokens to the owner's workspace without a browser session. Existing workspace URLs remain available for connected clients. When deploying the shared endpoint, apply hosted migration `0007_mcp_routing.sql` and run `node scripts/backfill-mcp-routes.mjs .private/launch/resources.json .private/launch` to index existing token hashes before deploying the gateway.

For the current beta workspace, deploy in this order. Updating the workspace before backfilling also indexes tokens created during the rollout. The regular `hosted:launch deploy` workflow performs the backfill automatically.

```sh
npm run build
npx wrangler d1 migrations apply CONTROL --remote --config .private/launch/portal.json
npx wrangler deploy --config .private/launch/beta01.json
node scripts/backfill-mcp-routes.mjs .private/launch/resources.json .private/launch
npx wrangler deploy --config .private/launch/portal.json
```

Verify that an unauthenticated request to `https://finance.phooey.foo/mcp` returns `401` with a `WWW-Authenticate` header pointing to the main-domain resource metadata. Both `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` must return JSON without signing in. Then initialize an MCP client with an existing personal token or complete a new OAuth consent flow.

Clients supporting OAuth discover the authorization server from the unauthenticated response, register a redirect, and open the admin login/consent screen. Authorization requires PKCE S256 and a resource of the exact MCP URL. OAuth access tokens expire after 365 days. Clients reauthorize at expiry because the server does not issue refresh tokens.

For clients using a manually configured bearer token, create one in Settings with the minimum required scopes, then add `Authorization: Bearer TOKEN` to the client's request headers. The default lifetime is 365 days. You can choose any lifetime from 1 to 365 days and revoke individual tokens in Settings. Never put a token in a URL.

| Scope                | Tools                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `finance:read`       | `list_accounts`, `search_transactions`, `get_transaction`, `list_categories`, `list_rules`, `preview_rule`, `get_report`, `get_tax_estimate`, `simulate_taxes`, `get_job`, `export_transactions` |
| `transactions:write` | `create_transaction`, `update_transaction`, `categorize_transactions`, `link_transfer`                                                                                                           |
| `rules:write`        | `save_category`, `save_rule`, `apply_rule`                                                                                                                                                       |
| `tax:write`          | `save_tax_profile`, `record_tax_payment`                                                                                                                                                         |
| `sync:write`         | `request_sync`                                                                                                                                                                                   |

Amounts use integer hundredths, including USD cents. Dates use `YYYY-MM-DD`. `search_transactions` accepts text, dates, account, category, type, currency, signed amount limits, source, pending/review state and pagination. Get a transaction before updating it; its current revision is required.

Create/update transaction, save category/rule and record payment calls require `request_key`. Generate one key for each intended operation and reuse it if the response is lost. A reused key with different data is rejected. Bulk categorization and tax-plan saves use revisions; reread after a conflict. Writes are attributed to the token ID in the audit history.

`export_transactions` returns a job ID and authenticated download path. Poll `get_job`; download only when status is `complete`. The URL is not a public signed link: use an admin session or a token with `finance:read`. Exports expire after 24 hours. Imports and complete backups are administered through the dashboard.

The server reports tool errors without disclosing secrets. It does not autonomously choose a tax filing, move money, initiate bank payments or grant additional scopes.
