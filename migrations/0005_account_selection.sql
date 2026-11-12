ALTER TABLE connections ADD COLUMN selected_accounts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE connections ADD COLUMN available_accounts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE connections ADD COLUMN selection_ready INTEGER NOT NULL DEFAULT 0;
/* Existing connections require an explicit selection before any further import. */
UPDATE connections SET status='selecting',generation=lower(hex(randomblob(16))),available_accounts=(SELECT COALESCE(json_group_array(json_object('id',provider_id,'name',name,'institution',institution,'currency',currency)), '[]') FROM accounts WHERE source='simplefin' AND provider_id IS NOT NULL);
UPDATE jobs SET status='cancelled',progress='Choose accounts before syncing',lease_until=0 WHERE kind='sync' AND status IN ('queued','running');
