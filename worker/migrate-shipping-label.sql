-- 送り状（ヤマト B2クラウド）CSV の一括出力（既存 D1 に適用）
-- status は増やさず、未発送の内訳として「送り状作成済み」を持たせる
ALTER TABLE orders ADD COLUMN shipping_label_batch_id TEXT;
ALTER TABLE orders ADD COLUMN shipping_label_at TEXT;

-- 発行時点の CSV 本文をそのまま持つ（住所を後で直しても発行内容が残る）
CREATE TABLE IF NOT EXISTS shipping_label_batches (
  id TEXT PRIMARY KEY,
  ship_date TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  csv TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_orders_shipping_label ON orders(shipping_label_batch_id);
