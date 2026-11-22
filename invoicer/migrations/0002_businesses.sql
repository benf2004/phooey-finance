-- Preserve existing records as the first business.
CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
INSERT INTO businesses(id,name) SELECT 'default', COALESCE(NULLIF(json_extract(document,'$.business.name'),''),'My business') FROM settings WHERE id=1;
DROP TRIGGER issue_invoice;
DROP TRIGGER sync_number_settings;
CREATE TABLE business_settings (id TEXT PRIMARY KEY REFERENCES businesses(id), document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
INSERT INTO business_settings SELECT 'default',document,revision FROM settings;
CREATE TABLE business_counters (id TEXT PRIMARY KEY REFERENCES businesses(id), prefix TEXT NOT NULL DEFAULT 'INV-', next_number INTEGER NOT NULL DEFAULT 1 CHECK(next_number>0));
INSERT INTO business_counters SELECT 'default',prefix,next_number FROM counters;
DROP TABLE settings;
DROP TABLE counters;
ALTER TABLE business_settings RENAME TO settings;
ALTER TABLE business_counters RENAME TO counters;
ALTER TABLE customers ADD COLUMN business_id TEXT NOT NULL DEFAULT 'default' REFERENCES businesses(id);
ALTER TABLE presets ADD COLUMN business_id TEXT NOT NULL DEFAULT 'default' REFERENCES businesses(id);
ALTER TABLE assets ADD COLUMN business_id TEXT NOT NULL DEFAULT 'default' REFERENCES businesses(id);
-- Rebuild invoices to scope the unique invoice number to its business.
CREATE TABLE invoices_new (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL DEFAULT 'default' REFERENCES businesses(id),
 state TEXT NOT NULL CHECK(state IN ('draft','issued','void')) DEFAULT 'draft', number TEXT,
 document TEXT NOT NULL, totals TEXT NOT NULL, amount_paid INTEGER NOT NULL DEFAULT 0 CHECK(amount_paid>=0),
 revision INTEGER NOT NULL DEFAULT 1, archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(business_id,number));
INSERT INTO invoices_new SELECT id,'default',state,number,document,totals,amount_paid,revision,archived_at,created_at,updated_at FROM invoices;
CREATE TABLE shares_backup AS SELECT * FROM shares;
CREATE TABLE idempotency_backup AS SELECT * FROM idempotency;
DROP TABLE shares;
DROP TABLE idempotency;
DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;
CREATE TABLE shares (invoice_id TEXT PRIMARY KEY REFERENCES invoices(id), token_hash TEXT UNIQUE NOT NULL);
INSERT INTO shares SELECT * FROM shares_backup;
DROP TABLE shares_backup;
CREATE TABLE idempotency (key TEXT NOT NULL, business_id TEXT NOT NULL DEFAULT 'default' REFERENCES businesses(id), request_hash TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id), created_at INTEGER NOT NULL, PRIMARY KEY(business_id,key));
INSERT INTO idempotency SELECT key,'default',request_hash,invoice_id,created_at FROM idempotency_backup;
DROP TABLE idempotency_backup;
CREATE INDEX invoices_history ON invoices(business_id,archived_at,created_at DESC,id);
CREATE INDEX customers_business ON customers(business_id);
CREATE INDEX presets_business ON presets(business_id);
CREATE INDEX assets_business ON assets(business_id);
CREATE TRIGGER issue_invoice AFTER UPDATE OF state ON invoices WHEN OLD.state='draft' AND NEW.state='issued'
BEGIN
 UPDATE invoices SET number=COALESCE(NULLIF(json_extract(NEW.document,'$.invoiceNumber'),''),(SELECT prefix || printf('%04d',next_number) FROM counters WHERE id=NEW.business_id)) WHERE id=NEW.id;
 UPDATE counters SET next_number=next_number+1 WHERE id=NEW.business_id AND COALESCE(json_extract(NEW.document,'$.invoiceNumber'),'')='';
END;
CREATE TRIGGER sync_number_settings AFTER UPDATE OF document ON settings
BEGIN
 UPDATE counters SET prefix=COALESCE(json_extract(NEW.document,'$.numberPrefix'),'INV-'),next_number=MAX(next_number,COALESCE(json_extract(NEW.document,'$.nextNumber'),1)) WHERE id=NEW.id;
 UPDATE businesses SET name=COALESCE(NULLIF(json_extract(NEW.document,'$.business.name'),''),name) WHERE id=NEW.id;
END;
CREATE TABLE api_keys (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','write')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), revoked_at TEXT);
