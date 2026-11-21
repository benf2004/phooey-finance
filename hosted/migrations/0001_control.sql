-- Only the hosted edition binds this database. Financial records live in individual workspace databases.
CREATE TABLE customers (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
 stripe_customer TEXT UNIQUE, subscription TEXT, billing_revision INTEGER NOT NULL DEFAULT 0,
 paid_until INTEGER NOT NULL DEFAULT 0, checkout_attempt TEXT, checkout_id TEXT
);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE, owner TEXT UNIQUE REFERENCES customers(id));
CREATE TABLE sessions (digest TEXT PRIMARY KEY, customer TEXT NOT NULL REFERENCES customers(id), audience TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE challenges (digest TEXT PRIMARY KEY, audience TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE waitlist (email TEXT PRIMARY KEY, joined INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires);
CREATE INDEX challenge_expiry ON challenges(expires);
