CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
INSERT INTO settings VALUES (1, '{}', 1);
CREATE TABLE counters (id INTEGER PRIMARY KEY CHECK(id = 1), prefix TEXT NOT NULL DEFAULT 'INV-', next_number INTEGER NOT NULL DEFAULT 1 CHECK(next_number > 0));
INSERT INTO counters (id) VALUES (1);
CREATE TABLE customers (id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes) <= 262144), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('draft','issued','void')) DEFAULT 'draft',
  number TEXT UNIQUE,
  document TEXT NOT NULL,
  totals TEXT NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX invoices_history ON invoices(archived_at, created_at DESC, id);
CREATE TRIGGER issue_invoice AFTER UPDATE OF state ON invoices
WHEN OLD.state = 'draft' AND NEW.state = 'issued'
BEGIN
  UPDATE invoices SET number = COALESCE(NULLIF(json_extract(NEW.document, '$.invoiceNumber'), ''), (SELECT prefix || printf('%04d', next_number) FROM counters WHERE id = 1)) WHERE id = NEW.id;
  UPDATE counters SET next_number = next_number + 1 WHERE id = 1 AND COALESCE(json_extract(NEW.document, '$.invoiceNumber'), '') = '';
END;
CREATE TABLE shares (invoice_id TEXT PRIMARY KEY REFERENCES invoices(id), token_hash TEXT UNIQUE NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, key_fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_end INTEGER NOT NULL);
CREATE TABLE idempotency (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id), created_at INTEGER NOT NULL);
CREATE TRIGGER sync_number_settings AFTER UPDATE OF document ON settings
BEGIN
  UPDATE counters SET prefix = COALESCE(json_extract(NEW.document, '$.numberPrefix'), 'INV-'), next_number = MAX(next_number, COALESCE(json_extract(NEW.document, '$.nextNumber'), 1)) WHERE id = 1;
END;
