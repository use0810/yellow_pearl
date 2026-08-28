-- 予約ごとの配達時間帯（B2クラウドコード。お客様入力は持たない）
ALTER TABLE orders ADD COLUMN delivery_time TEXT NOT NULL DEFAULT '';
