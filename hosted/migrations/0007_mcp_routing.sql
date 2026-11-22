-- The gateway stores routing hints only; ledgers still validate every credential.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE mcp_routes (
  kind TEXT NOT NULL CHECK(kind IN ('token','code')),
  digest TEXT NOT NULL,
  workspace TEXT NOT NULL REFERENCES workspaces(id),
  expires INTEGER NOT NULL,
  PRIMARY KEY(kind,digest)
);
CREATE INDEX mcp_routes_expiry ON mcp_routes(expires);
