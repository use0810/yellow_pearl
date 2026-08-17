-- 銀行振込の専用口座を注文に保存する（既存 D1 に適用）
-- 振込先は注文ごとに異なるため、Stripe の振込手順を JSON で持たせる
ALTER TABLE orders ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE orders ADD COLUMN bank_transfer_info TEXT;
