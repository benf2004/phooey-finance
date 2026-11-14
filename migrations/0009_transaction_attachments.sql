CREATE TABLE transaction_attachments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 20971520),
  original_size INTEGER NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','ready')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX attachments_transaction ON transaction_attachments(transaction_id);
CREATE TABLE attachment_cleanup (
  object_key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TRIGGER attachment_removed AFTER DELETE ON transaction_attachments BEGIN
  INSERT OR IGNORE INTO attachment_cleanup(object_key) VALUES(OLD.object_key);
END;
CREATE TRIGGER transaction_attachments_deleted AFTER UPDATE OF deleted ON transactions WHEN NEW.deleted=1 BEGIN
  DELETE FROM transaction_attachments WHERE transaction_id=NEW.id;
END;
