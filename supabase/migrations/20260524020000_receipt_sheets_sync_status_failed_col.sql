-- Add failed/error_message columns to receipt_sheets_sync_status
-- so the GAS sidebar knows whether sync errored out
ALTER TABLE receipt_sheets_sync_status
  ADD COLUMN IF NOT EXISTS failed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS error_message text;
