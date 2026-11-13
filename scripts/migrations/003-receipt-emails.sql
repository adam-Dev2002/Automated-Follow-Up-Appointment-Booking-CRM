CREATE TABLE IF NOT EXISTS crm_receipt_emails (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL UNIQUE REFERENCES crm_payments(id),
    request_id TEXT NOT NULL UNIQUE,
    receipt_digest TEXT NOT NULL,
    recipient TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Queued','Sending','Sent','Needs review')),
    execution_id TEXT,
    gmail_message_id TEXT,
    detail TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES workspace_users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_receipt_emails_queue ON crm_receipt_emails(status,created_at);
CREATE TABLE IF NOT EXISTS crm_receipt_sender (
    id INTEGER PRIMARY KEY CHECK(id=1),
    email TEXT NOT NULL,
    checked_at TEXT NOT NULL
);
