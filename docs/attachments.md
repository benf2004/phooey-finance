# Transaction attachments

Saved transactions support receipts and invoices from the transaction editor. Files save immediately, independently of monetary/category edits. New transactions show a save-first instruction. The compact list scrolls when it contains many files; clicking a filename opens an in-app preview. Images offer fit/actual-size viewing; PDFs use the browser's full document viewer with explicit new-tab and download fallbacks. Escape closes the preview and restores focus to its filename.

Each row in the Transactions table has an upload button in the Receipts column. It opens the file picker directly. The adjacent paperclip count opens the editor and focuses its attachment section. Both images and PDFs count. Counts refresh after uploads/removals and come from an indexed `state='ready'` count in the existing transaction list/detail SQL, with no per-row HTTP requests. Upload reservations and deleted references do not count. Row-wide editing, checkbox selection, Type/category presentation, tag search and amount filters retain their existing behavior.

## Compression and supported files

Settings → Data → Receipt & invoice storage controls future image uploads:

| Preset             | Maximum longest edge | JPEG quality |
| ------------------ | -------------------: | -----------: |
| Balanced (default) |             2,800 px |          86% |
| Smaller files      |             2,000 px |          78% |
| More detail        |             4,000 px |          93% |
| Keep original      |            Unchanged |    Unchanged |

JPEG, PNG and WebP are supported directly. HEIC/HEIF and AVIF photos can be converted when the browser's native image decoder supports them; otherwise the UI asks for a JPEG export. No heavyweight HEIC decoder is bundled. Unsupported GIF/TIFF/SVG files must be exported into a supported format.

The browser respects decoded image orientation, never upscales, and uses a white JPEG background. It retains a supported original when encoding would increase size. Animated PNG/WebP are retained unchanged instead of dropping frames. HEIC/AVIF conversion that would enlarge a file is rejected with an export instruction. The UI reports actual uploaded versus source bytes. Compression is lossy: inspect small receipt text and use More detail or Keep original as needed. Changes to settings never rewrite existing files.

PDF bytes are preserved exactly, including all pages. No PDF optimizer, rasterizer, script evaluator, or document-rewriting library is used. There is no claimed PDF compression saving or ineffective PDF quality setting. A PDF above the limit must be optimized externally without dropping pages.

Limits are 20 stored files per transaction and 20 MiB per stored file. Input photos may be up to 40 MiB; decoded images above 60 megapixels are rejected before canvas processing. PDF inputs must already fit the 20 MiB limit. The interface uses MB/KB labels for binary sizes.

## API and access

- `GET/POST /api/transactions/:id/attachments`: list / upload.
- `GET /api/transactions/:id/attachments/:attachmentId`: stream a private file; `?download=1` sets attachment disposition.
- `DELETE /api/transactions/:id/attachments/:attachmentId`: remove the reference and object.
- `GET/POST /api/settings/attachment-compression`: read/save `{ "preset": "balanced" }` (or `smaller`, `detailed`, `original`).

Uploads use a raw binary body, an allowlisted content type, URI-encoded `X-File-Name`, `X-Original-Size`, and a UUID v4 `Idempotency-Key`. Retrying a completed upload with the same identifier/digest/name returns the existing attachment. A reused identifier with different data is rejected.

These routes inherit the existing admin-session-only API middleware and same-origin mutation check. Phooey currently has one owner per deployment; there is no per-user ownership column. Every file lookup also matches an active transaction in an unarchived account and its attachment ID, consistent with ledger visibility. Bearer finance tokens cannot access these endpoints. No public R2 URL is returned.

The server bounds the actual body stream (including requests without Content-Length), validates MIME and basic file signatures/terminators, and applies an atomic per-transaction count limit. Signature checks do not claim full document validation. File content is served with a fixed allowlisted MIME, nosniff, no-store, sandbox CSP, same-origin framing/resource restrictions, and sanitized download names. The authenticated preview fetches a bounded file and releases its object URL when closed. Browser PDF rendering capability varies; download always remains available.

## Persistence and cleanup

Migration `0009_transaction_attachments.sql` adds `transaction_attachments`, `attachment_cleanup`, indexes and deletion triggers. Apply pending production migrations before deploying the new Worker:

```sh
npm run db:migrate:production
```

The existing private `FILES` R2 binding stores `attachments/<transaction-id>/<random-object-id>`. Uploads first reserve an `uploading` database reference, then write R2 and conditionally mark it `ready`. This order leaves a discoverable reference if a request dies. Failed uploads attempt immediate cleanup; durable tombstones retain failed cleanup work.

Removing an attachment attempts immediate R2 deletion. Soft-deleting a transaction and physically deleting transactions (including account deletion/data reset) remove attachment references and enqueue R2 cleanup through database triggers. File access stops as soon as the reference/transaction is deleted. Scheduled cleanup removes stale upload reservations and processes at most 100 old tombstones per invocation. An hour's grace prevents races with in-flight writes. Physical cleanup may wait until the existing twice-daily cron (and additional invocations for a large backlog). Failed object deletion keeps the tombstone for retry. Cleanup runs after existing sync/job/session housekeeping.

Compression preferences are atomically merged into `settings.preferences.attachmentCompression`, preserving profile and transaction appearance preferences. Existing JSON backups include that preference but **exclude attachment files and attachment references**. Both the Data tab and backup response state the exclusion; the response also reports the count. Download files separately for a portable copy. Full deployment recovery requires D1 (including attachment metadata) and its matching R2 objects.

## Verification

`npm run typecheck`, `npm run build`, `npm test`, and `node tests/attachments-ui.mjs` validate the feature. Tests use disposable Miniflare D1/R2 storage, synthetic documents/images, and a fresh browser profile; no production or real user documents are used.

Integration coverage includes session/origin checks, cross-transaction access, missing/deleted transactions, MIME/signature/size rejection, count limits, idempotent retries, byte-exact multi-page PDF downloads, safe headers/names, deletion cascades, stale uploads, storage failures and deletion during upload. Browser coverage includes actual compression, settings persistence, keeping smaller originals, preview/zoom/Escape/focus, PDF viewing/download, retry/removal, phone-format errors, mobile reachability and save-first guidance.

Measured synthetic receipt: 8,588,131 source bytes → 908,776 bytes with Balanced (89.4% reduction) or 210,809 bytes with Smaller files (97.5%). These measurements are fixture-specific, not a savings guarantee. The synthetic two-page PDF remains exactly 890 bytes.
