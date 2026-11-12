# MCP server

Endpoint: `https://YOUR-WORKER.workers.dev/mcp`. Transport: Streamable HTTP. The dashboard Settings page shows the exact URL.

Clients supporting OAuth discover the authorization server from the unauthenticated response, register a redirect, and open the admin login/consent screen. Authorization requires PKCE S256 and a resource of the exact MCP URL. Access tokens expire after one day; clients reauthorize (refresh tokens are not issued).

For clients using a manually configured bearer token, create one in Settings with the minimum required scopes, then add `Authorization: Bearer TOKEN` to the client's request headers. Tokens expire in 1–365 days and can be revoked individually. Never put a token in a URL.

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
