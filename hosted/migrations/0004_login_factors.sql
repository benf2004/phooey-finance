ALTER TABLE customers ADD COLUMN security_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE login_keys (
  id TEXT PRIMARY KEY,
  customer TEXT NOT NULL REFERENCES customers(id),
  role TEXT NOT NULL CHECK (role IN ('primary','second')),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX login_keys_owner ON login_keys(customer,role);
CREATE TRIGGER login_key_role BEFORE INSERT ON login_keys
WHEN EXISTS(SELECT 1 FROM login_keys WHERE customer=NEW.customer AND role<>NEW.role)
BEGIN SELECT RAISE(ABORT,'Passkeys already have another role'); END;
CREATE TABLE login_totp (
  customer TEXT PRIMARY KEY REFERENCES customers(id),
  secret TEXT NOT NULL,
  last_step INTEGER NOT NULL
);
CREATE TABLE login_identities (
  subject TEXT PRIMARY KEY, customer TEXT NOT NULL REFERENCES customers(id)
);
INSERT INTO login_identities SELECT subject,id FROM customers;
CREATE TRIGGER register_login_identity AFTER INSERT ON customers
BEGIN INSERT INTO login_identities VALUES(NEW.subject,NEW.id); END;

CREATE TRIGGER key_added AFTER INSERT ON login_keys
BEGIN UPDATE customers SET security_version=security_version+1 WHERE id=NEW.customer; END;
CREATE TRIGGER key_removed AFTER DELETE ON login_keys
BEGIN UPDATE customers SET security_version=security_version+1 WHERE id=OLD.customer; END;
CREATE TRIGGER totp_added AFTER INSERT ON login_totp
BEGIN UPDATE customers SET security_version=security_version+1 WHERE id=NEW.customer; END;
CREATE TRIGGER totp_removed AFTER DELETE ON login_totp
BEGIN UPDATE customers SET security_version=security_version+1 WHERE id=OLD.customer; END;
CREATE TRIGGER reset_auth AFTER UPDATE OF security_version ON customers
BEGIN
  DELETE FROM sessions WHERE customer=NEW.id;
  DELETE FROM challenges WHERE json_extract(payload,'$.customer')=NEW.id;
END;
