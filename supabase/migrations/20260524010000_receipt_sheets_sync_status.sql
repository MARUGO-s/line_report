-- Tracks background sync completion so GAS can poll and notify the user
CREATE TABLE IF NOT EXISTS receipt_sheets_sync_status (
  id               int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_completed_at timestamptz,
  direction        text,
  updated_at       timestamptz DEFAULT now()
);

-- Seed a row so upsert always hits an existing row
INSERT INTO receipt_sheets_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Service role can read/write; anon cannot
ALTER TABLE receipt_sheets_sync_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON receipt_sheets_sync_status
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
