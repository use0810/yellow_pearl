-- 監査ログ・ソフト削除（既存 D1 に適用）
-- 続けて migrate-payment-cancelled.sql も実行すること
ALTER TABLE orders ADD COLUMN archived_at TEXT;ALTER TABLE orders ADD COLUMN archived_by TEXT;

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
