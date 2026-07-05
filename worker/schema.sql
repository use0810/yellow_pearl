CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL UNIQUE,
  stock INTEGER NOT NULL DEFAULT 1000,
  sold_out INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  tax_rate INTEGER NOT NULL DEFAULT 10,
  shipping_tax_rate INTEGER NOT NULL DEFAULT 10
);

INSERT OR IGNORE INTO inventory (product_id, stock, sold_out, unit_price, tax_rate, shipping_tax_rate)
VALUES ('yellow-pearl', 1000, 0, 0, 10, 10);

CREATE TABLE IF NOT EXISTS shipping_rates (
  prefecture TEXT PRIMARY KEY,
  fee INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name_kana TEXT,
  first_name_kana TEXT,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  postal TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  address1 TEXT NOT NULL,
  address2 TEXT,
  note TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  shipping_tax_rate INTEGER NOT NULL DEFAULT 10,
  shipping_tax_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT '未決済',
  stripe_session_id TEXT,
  stripe_payment_id TEXT,
  status TEXT NOT NULL DEFAULT '予約',
  admin_note TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  archived_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monthly_expenses (
  year_month TEXT PRIMARY KEY,
  actual_shipping INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);
