ALTER TABLE connections ADD COLUMN generation TEXT NOT NULL DEFAULT 'initial';
CREATE UNIQUE INDEX one_active_sync ON jobs(kind) WHERE kind='sync' AND status IN ('queued','running');
