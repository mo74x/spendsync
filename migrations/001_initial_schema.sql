CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Raw inbound events (immutable source of truth)
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT
);

-- 2. Category to Chart of Accounts (GL) Mapping
CREATE TABLE category_gl_mapping (
  category TEXT PRIMARY KEY,
  expense_account TEXT NOT NULL,
  description TEXT
);

INSERT INTO category_gl_mapping (category, expense_account, description) VALUES
  ('software', '600100', 'IT & Cloud Software Services'),
  ('travel', '600200', 'Travel & Lodging'),
  ('meals', '600300', 'Meals & Entertainment'),
  ('fees', '600400', 'Bank & Processing Fees')
ON CONFLICT DO NOTHING;

-- 3. Double-entry journal entries
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id),
  transaction_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  card_last4 VARCHAR(4) NOT NULL,
  merchant_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. ERP sync tracking
CREATE TABLE odoo_sync_status (
  journal_entry_id UUID PRIMARY KEY REFERENCES journal_entries(id),
  odoo_move_id INT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);