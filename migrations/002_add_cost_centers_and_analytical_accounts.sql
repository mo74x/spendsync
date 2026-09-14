-- Migration 002: Add Cost Centers and Analytical Accounts (Department Tracking)

-- 1. Create table for Cost Center to Odoo Analytical Account mapping
CREATE TABLE IF NOT EXISTS cost_center_analytic_mapping (
  cost_center TEXT PRIMARY KEY,
  analytic_account_code TEXT NOT NULL,
  description TEXT
);

-- Seed initial common department mappings
INSERT INTO cost_center_analytic_mapping (cost_center, analytic_account_code, description) VALUES
  ('engineering', '1010', 'Engineering & Tech Infrastructure'),
  ('marketing', '1020', 'Marketing & Growth'),
  ('sales', '1030', 'Sales & Business Development'),
  ('operations', '1040', 'General Operations & Facilities'),
  ('finance', '1050', 'Finance & Administration')
ON CONFLICT DO NOTHING;

-- 2. Add cost_center and analytic_account_code columns to journal_entries
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS cost_center VARCHAR(100),
  ADD COLUMN IF NOT EXISTS analytic_account_code VARCHAR(100);
