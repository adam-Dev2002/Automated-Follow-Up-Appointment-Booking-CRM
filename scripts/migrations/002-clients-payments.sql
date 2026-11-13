CREATE TABLE IF NOT EXISTS crm_clients (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('manual', 'booking')),
    request_id TEXT UNIQUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_clients_email ON crm_clients(email) WHERE email <> '';
CREATE TABLE IF NOT EXISTS crm_appointment_clients (
    appointment_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES crm_clients(id),
    linked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_appointment_clients_client ON crm_appointment_clients(client_id);
CREATE TABLE IF NOT EXISTS crm_booking_charges (
    appointment_id TEXT PRIMARY KEY,
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    currency TEXT NOT NULL CHECK (currency = 'PHP'),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_payments (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    appointment_id TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES crm_clients(id),
    service TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('paid', 'partial', 'deposit', 'refund')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL CHECK (currency = 'PHP'),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'other')),
    receipt_reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    refund_of TEXT REFERENCES crm_payments(id),
    received_at TEXT NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES workspace_users(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_payments_appointment ON crm_payments(appointment_id, received_at);
CREATE INDEX IF NOT EXISTS crm_payments_client ON crm_payments(client_id, received_at);
CREATE INDEX IF NOT EXISTS crm_payments_received ON crm_payments(received_at);
