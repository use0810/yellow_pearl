-- 送り状バッチに B2クラウドの配達時間帯コードを残す（既存 D1 に適用）
ALTER TABLE shipping_label_batches ADD COLUMN delivery_time TEXT NOT NULL DEFAULT '';
