ALTER TABLE transactions ADD COLUMN tags TEXT NOT NULL DEFAULT '["Business"]' CHECK(json_valid(tags) AND json_type(tags)='array');
UPDATE settings SET value=json_set(value,'$.mode','quarterly','$.transactionTag',COALESCE(json_extract(value,'$.transactionTag'),'Business')),revision=revision+1 WHERE key GLOB 'tax:[0-9][0-9][0-9][0-9]';
