PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  producer TEXT,
  vintage TEXT,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  UNIQUE(product_id, alias)
);

CREATE TABLE IF NOT EXISTS ingestion_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  period_ym TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_rows INTEGER NOT NULL DEFAULT 0,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_hash)
);

CREATE TABLE IF NOT EXISTS ingestion_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_file_id INTEGER NOT NULL REFERENCES ingestion_files(id) ON DELETE CASCADE,
  row_no INTEGER,
  error_code TEXT NOT NULL,
  error_message TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  effective_date TEXT NOT NULL,
  source_file_id INTEGER REFERENCES ingestion_files(id) ON DELETE SET NULL,
  source_row_no INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS current_prices (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  latest_price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  effective_date TEXT NOT NULL,
  history_id INTEGER NOT NULL REFERENCES price_history(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, store_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_reply_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  user_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ocr_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_event_id TEXT,
  image_id TEXT,
  extracted_text TEXT,
  guessed_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON product_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_price_history_lookup ON price_history(product_id, store_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_current_prices_store ON current_prices(store_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_file_period ON ingestion_files(period_ym, status);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, created_at DESC);

INSERT OR IGNORE INTO line_reply_templates(template_key, body, is_active)
VALUES
  ('price_found', '{{product_name}} の最新価格です。\n{{lines}}', 1),
  ('price_not_found', '{{query}} に一致する価格が見つかりませんでした。', 1),
  ('image_received', '画像を受け取りました。解析結果を返します。', 1);
