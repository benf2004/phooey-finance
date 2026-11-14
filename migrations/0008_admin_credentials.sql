/* Authentication state is deliberately separate from ledger backups and resets. */
CREATE TABLE admin_credentials (
  id INTEGER PRIMARY KEY CHECK(id=1),
  bootstrap_version TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  revision TEXT NOT NULL
);
