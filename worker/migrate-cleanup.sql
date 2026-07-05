-- 既存 DB の整理（本番適用: wrangler d1 execute yellow-pearl-db --remote --file=./migrate-cleanup.sql）
-- エラー「duplicate column name」等は既に適用済み — 該当行をスキップしてよい

-- KOMOJU 名残 → Stripe カラム名（SQLite 3.25+）
ALTER TABLE orders RENAME COLUMN komoju_session_id TO stripe_session_id;
ALTER TABLE orders RENAME COLUMN komoju_payment_id TO stripe_payment_id;

-- 旧パスワード認証テーブル（Access 移行後）
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS admin_login_attempts;
DROP TABLE IF EXISTS login_attempts;

-- レート制限（Worker が CREATE IF NOT EXISTS でも可）
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL
);
