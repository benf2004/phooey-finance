ALTER TABLE connections ADD COLUMN initial_sync_start TEXT;
/* Preserve the existing range for connections that have already synced. */
UPDATE connections SET initial_sync_start=date(last_success, '-45 days') WHERE last_success IS NOT NULL;
