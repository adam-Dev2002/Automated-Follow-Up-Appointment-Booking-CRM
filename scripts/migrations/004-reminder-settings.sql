CREATE TABLE IF NOT EXISTS workspace_reminder_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_email TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO workspace_reminder_settings (id) VALUES (1);
