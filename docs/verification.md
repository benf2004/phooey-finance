# Release verification — 2026-11-12

Deployment: https://phooey-finance.aipromptgenius.workers.dev

| Requirement                | Implementation and evidence                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare runtime/storage | Production Worker bound to separate D1, R2 and Queue; all migrations applied. Cron and queue consumer deployed. Production queued export/download passed.                                                        |
| One administrator          | Server-secret username/password hash; live login passed; anonymous API denied; cross-origin write denied; secure session cookie verified.                                                                        |
| SimpleFIN                  | Setup-token exchange, encrypted access URL, bounded staged sync, history windows, generation guard. Official live demo test passed; fixture tests cover 205 rows, manual overrides and replaced connection race. |
| Categorization             | Ordered rules, preview/apply, category and tax treatment services; shared ledger validation and atomic idempotency.                                                                                              |
| Accounts/types/categories  | Manual and provider accounts, income/expense/transfer types, split validation, transfer linking and report exclusions. Integration tests cover transactions, splits and transfers.                               |
| Dashboard/search/edit      | Compact React pages, CSV/import controls, FTS and compound filters, edit history and revisions. UI inspection confirmed collapsed tax inputs and neutral compact styling.                                        |
| Taxes                      | Marginal federal/state models, flat state rates, editable assumptions, SE taxes, payments, safe-harbor target. Domain tests cover band boundaries, caps, credits, installment allocation and payment timing.     |
| Import/export              | Preview mapping and duplicate detection; interrupted import resumes without duplicates. Streaming browser export and queued MCP export. 1,201-row CSV round trip passes without repeated BOM.                    |
| Backup/restore             | Atomic validated portable restore tested with splits; incomplete import backup rejected. SQL export of local demo restored into a separate empty SQLite database: 4 accounts / 110 transactions.                 |
| MCP                        | 21 tools exposed in production. OAuth PKCE/single-use code integration test passes. Live read-only token allowed reads and rejected tax writes. Temporary smoke token revoked afterward.                         |
| FOSS                       | AGPL license preserved. Source archive built from an allowlist, excludes secrets/database files. Live archive SHA-256 matched the local build.                                                                   |
| Deployment/docs            | Local setup, production setup, operating limits, MCP permissions, tax assumptions, recovery instructions and CI are included. Production credentials remain in ignored owner-readable files.                     |

`npm run check`: typecheck, current build, then 32 tests passed; one live-provider test is skipped by default. Running the live job suite separately passed all 7 tests, including the SimpleFIN demo. `npm audit` reported no vulnerabilities. Four read-only review-agent passes were performed; identified defects were repaired, and the final pass reported no findings. Worker startup was 65 ms on the first production deployment.

A real user bank connection is intentionally not configured. Production starts with no financial accounts or transactions. Tax state tables beyond the supplied federal preset must be configured and verified by the user. CSV exports are live bounded reads, not a locked financial snapshot; portable backup is the lossless migration format.
