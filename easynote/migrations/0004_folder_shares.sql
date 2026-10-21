CREATE TABLE folder_shares (
  token_hash TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id) ON DELETE CASCADE,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX folder_shares_expiry ON folder_shares(expires_at);
