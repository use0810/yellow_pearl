-- D1: 管理画面から Stripe テスト/本番モードを切り替える
ALTER TABLE inventory ADD COLUMN stripe_mode TEXT NOT NULL DEFAULT 'test';

UPDATE inventory SET stripe_mode = 'test' WHERE stripe_mode IS NULL OR stripe_mode = '';
