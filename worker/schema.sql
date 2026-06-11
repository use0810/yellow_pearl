CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL UNIQUE,
  stock INTEGER NOT NULL DEFAULT 1000,
  total INTEGER NOT NULL DEFAULT 1000,
  sold_out INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO inventory (product_id, stock, total, sold_out, unit_price)
VALUES ('yellow-pearl', 1000, 1000, 0, 0);

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
  total_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '予約',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);
