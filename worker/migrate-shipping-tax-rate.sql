-- 送料の消費税率（商品 tax_rate とは別）
-- エラー「duplicate column name」は既に適用済み — 該当行をスキップしてよい
ALTER TABLE inventory ADD COLUMN shipping_tax_rate INTEGER NOT NULL DEFAULT 10;
ALTER TABLE orders ADD COLUMN shipping_tax_rate INTEGER NOT NULL DEFAULT 10;
ALTER TABLE orders ADD COLUMN shipping_tax_amount INTEGER NOT NULL DEFAULT 0;
