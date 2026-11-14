# Transaction CSV import

Open **Import transactions**, download the template, replace the example rows, select an account, and choose the file. Preview the mapping and rows before submitting. Files need a header and support up to 5,000 transaction rows / 1.5 MB. Quote cells containing commas, double quotes, or line breaks; double embedded quotes as `""`.

The three required mappings remain Date, Description, and Amount. Dates default to `YYYY-MM-DD`; `MM/DD/YYYY` and `DD/MM/YYYY` can be selected. Amounts use decimal units, not cents, with at most two decimal places: `1500.00` for income and `-45.25` for expenses. The existing **Invert amounts** option reverses signs. A positive amount can also be an expense refund when Type is `expense`.

**Optional columns** exposes these mappings. Recognized headers are selected automatically (ignoring case, surrounding whitespace, underscores and hyphens); each mapping can be changed or set to **Do not import**.

| Column | Format and aliases | Missing or blank behavior |
| --- | --- | --- |
| Tags | `Business;Client A` or a JSON string array such as `["Business","Client A"]`. Aliases: Tag, Labels. | An absent/unmapped column retains the `Business` default. A mapped blank cell or `[]` explicitly imports no tags. |
| Merchant | Text, up to 200 characters. Aliases: Merchant Name, Vendor. | Empty merchant. |
| Notes | Text, up to 4,000 characters. Aliases: Note, Comments, Comment. Quoted multiline cells are supported. | Empty notes. |
| Category | Existing category name (case-insensitive) or exact ID. Aliases: Category Name, Category ID. | Matching rules can categorize the transaction. Unknown or ambiguous names are errors; use an ID to disambiguate. Categories are not created automatically. |
| Type | `income`, `expense`, or `transfer` (case-insensitive). Alias: Transaction Type. | Inferred from the amount sign: nonnegative income, negative expense. Matching rules can change the type for uncategorized rows, as with basic imports. |
| Pending | `true`/`false`, `yes`/`no`, or `1`/`0` (case-insensitive). Alias: Is Pending. | False. |
| Reviewed | Same boolean formats as Pending. Alias: Is Reviewed. | False (new basic imports remain unreviewed). |

Tags are trimmed, limited to 20 supplied entries of 1–50 characters, and deduplicated case-insensitively, retaining the first spelling. Empty entries in a nonempty list are errors. Use JSON for names containing semicolons, or names starting with `[`. CSV quoting for a JSON tag list looks like `"[""Business"",""Client A""]"`. Exported Tags already use this representation. A mapped column missing from a short row is an error; add an explicit empty cell to request its blank behavior.

Date aliases include Posted, Posted Date, Posting Date, and Transaction Date; Description accepts Memo, Payee, and Transaction Description; Amount accepts Transaction Amount and Net Amount. Required columns with unrecognized headers can be selected manually. Selecting a new file resets mappings and date/sign options to their defaults, so check these in the preview.

Preview shows CSV record numbers (header is record 1), tags and expandable field details, row-specific validation errors, and possible duplicates. Resolve invalid rows or explicitly skip them; no import is staged while an included row is invalid. Identical transactions are only flagged, never automatically discarded. Import-specific request keys preserve retries and resume behavior. Explicit categories bypass automatic categorization; blank categories retain the existing rule behavior, including merchant rules.

The selected account supplies the account and currency for every row. Account, Currency, Transaction ID, Splits, and attachment data are not imported. Transfer type does not link transfer pairs. Existing export files can round-trip the supported columns, but CSV is not a lossless backup: splits, IDs, account relationships, attachments and history are omitted, rules can affect uncategorized rows, and spreadsheet-formula safety prefixes remain literal text. Use full backups for ledger restoration and retain attachment files separately (JSON backups exclude attachment files). When importing an export, filter it to the intended account/currency first and check the preview.
