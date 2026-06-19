-- KOMOJU 決済カラム（既存DB向け。エラーなら追加済み）
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT '未決済';
ALTER TABLE orders ADD COLUMN komoju_session_id TEXT;
ALTER TABLE orders ADD COLUMN komoju_payment_id TEXT;
