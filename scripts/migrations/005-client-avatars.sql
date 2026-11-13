CREATE TABLE IF NOT EXISTS crm_client_avatars (
    client_id TEXT PRIMARY KEY REFERENCES crm_clients(id),
    image BLOB,
    content_type TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
