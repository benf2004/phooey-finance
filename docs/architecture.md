# Architecture

One Cloudflare Worker serves the static Vite/React app, same-origin JSON API, OAuth endpoints and Streamable HTTP MCP endpoint. Scheduled events and a Queue consumer run in the same Worker. D1 is the source of truth; R2 stores import/sync staging and temporary export chunks. No Durable Object or external database is needed.

## Data model

Accounts hold their currency and balance snapshot. Transactions hold signed integer hundredths: positive inflow, negative outflow. Types are income, expense or transfer, independently of sign (a refund can be a positive expense). The current monetary precision is two decimal places; no automatic FX conversion. Reports never add different currencies.

Categories include tax treatment. Split allocations replace the parent's report classification and must sum exactly to the parent amount. Equal, opposite transactions in different same-currency accounts can be linked as a transfer; transfers are excluded from cash flow and tax profit. Editing uses optimistic revisions to detect stale clients. Deletion is soft for ledger transactions; historical edits remain in the audit table.

Rules are case-insensitive substring matches, ordered by priority, creation time and ID. Optional account, signed amount range and flow direction narrow matches. The first matching enabled rule wins. Imported and bank transactions can be auto-categorized. Explicit edits take priority over rules and provider updates.

## Sync and jobs

SimpleFIN setup tokens are claimed once on the server. The access URL is encrypted with AES-GCM using a Worker secret. Only the official Bridge hosts are accepted; redirects are rejected. No bank credentials pass through the app. Limits: 20 account fetches per day, four sync requests per hour, 45-day request windows. Connection setup fetches account names with `balances-only=1` and waits for an explicit selection. Sync requests include only selected account IDs; responses are filtered again before staging and ingestion. New accounts are never added automatically. Changing the selection cancels previous-generation jobs. Scheduled sync overlaps five days to refresh recent transactions; explicit historical backfill uses consecutive windows.

A connection generation prevents an old job or delayed response from changing a replacement connection. Each job has a lease and durable checkpoint. Provider responses are staged before transaction ingestion. Ingestion batches 100 transactions; imports batch 50; exports batch 500. The database commits sync records, progress and final watermark atomically. Replaying imports uses persistent row request keys. A lease collision retries instead of acknowledging unfinished work.

Stable `(account_id, provider_id)` keys prevent bank duplicates. Pending transactions are excluded from reports. If a bank changes the ID on posting, the app conservatively retains the unmatched pending entry; it does not guess which posted entry replaces it. Review and remove stale pending entries manually. Institution history availability is controlled by the provider.

## Security and authorization

New self-hosted installations use a random `ADMIN_KEY` of at least 32 characters. Login uses a timing-safe comparison of SHA-256 digests and creates a hashed, expiring browser session. Rotating the key invalidates those sessions. The [combined edition](self-hosted.md) mounts the existing Invoicer services under `/invoicer/`, shares Finance's browser session, and passes owner authorization internally only after checking that session and the mutation origin. Explicit Invoicer bearer credentials retain their original business scope. Each app keeps its own database. Hosted identity, billing and account-management services are not part of the combined Worker.

Legacy password installations remain supported:

There is one administrator initialized through server secrets: username, bcrypt password hash and encryption key. Settings can replace the password with a cost-12 bcrypt hash stored separately from financial data in D1. A fingerprint of the server credentials ties the override to that configuration, preserving secret rotation as an administrator recovery mechanism. Password changes require the current password and a same-origin browser session, are rate limited, and atomically verify the credential/session snapshot, replace the hash, invalidate browser sessions, and create a fresh current session. Session tokens and MCP tokens are stored only as hashes. Sessions last one day and are invalidated when admin credentials change. Cookies are HttpOnly and SameSite=Strict, with Secure on HTTPS. Mutations validate Origin; login attempts and OAuth endpoints are rate limited.

OAuth uses authorization codes with PKCE S256, exact registered redirects, single-use codes and resource-bound access. MCP tokens carry explicit scopes and are revoked in Settings. They cannot use ordinary dashboard API endpoints; authenticated export downloads are an intentional exception. MCP writes use the same validation, revisions and audit services as the dashboard.

Financial data is not added to application logs. Worker invocation logging is disabled to avoid persisting search query URLs. Error messages omit credentials and unexpected internal exception details. Static assets use CSP, nosniff and frame restrictions. No service-worker/offline copy of financial data is installed.

## Capacity

The app targets a personal ledger on Workers Paid. CSV import accepts up to 5,000 rows and a 1.5 MB CSV body per file. CSV export supports 100,000 filtered transactions, streamed in bounded batches; larger ledgers can export separate date ranges. CSV import maps date/description/amount plus optional tags, merchant, notes, category, type, pending and reviewed columns; see [CSV import formats](csv-import.md). Exported split JSON, IDs, account relationships and attachments are not imported. Use JSON or SQL backup for a lossless round trip.

Portable JSON restore accepts 10 MB and up to roughly 85,000 table records, including audit rows. It executes as one atomic batch into an empty, disconnected ledger. Larger datasets use D1 SQL tools. CSV export is a bounded live read: new rows after its initial boundary are excluded, but edits during an export may be reflected in later chunks. Pause edits if a consistent CSV snapshot is important. Portable JSON backup uses one read batch for its included tables.

References: [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [SimpleFIN developer guide](https://beta-bridge.simplefin.org/info/developers).
