ALTER TABLE customers ADD COLUMN pending_free INTEGER NOT NULL DEFAULT 0 CHECK(pending_free IN (0,1));
CREATE INDEX customer_email_directory ON customers(email COLLATE NOCASE, id);
CREATE TABLE account_admins (
  customer TEXT PRIMARY KEY REFERENCES customers(id)
);
CREATE TABLE free_accounts (
  customer TEXT PRIMARY KEY REFERENCES customers(id),
  granted_by TEXT NOT NULL REFERENCES customers(id),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE VIEW hosted_accounts AS
  SELECT c.*, EXISTS(SELECT 1 FROM account_admins a WHERE a.customer=c.id) AS is_admin,
    EXISTS(SELECT 1 FROM free_accounts f WHERE f.customer=c.id) AS complimentary
  FROM customers c;

CREATE TRIGGER reserve_free_workspace AFTER INSERT ON free_accounts
BEGIN
  UPDATE workspaces SET owner=NEW.customer
    WHERE id=(SELECT id FROM workspaces WHERE owner IS NULL ORDER BY id LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM workspaces WHERE owner=NEW.customer);
  SELECT RAISE(ABORT,'No available hosted workspace')
    WHERE NOT EXISTS(SELECT 1 FROM workspaces WHERE owner=NEW.customer);
END;

CREATE TRIGGER claim_free_identity AFTER UPDATE OF subject ON customers
WHEN OLD.pending_free=1 AND NEW.pending_free=0
BEGIN
  UPDATE login_identities SET subject=NEW.subject WHERE customer=NEW.id AND subject=OLD.subject;
END;
