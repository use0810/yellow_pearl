-- 不要になった管理用テーブルを削除（認証は Cloudflare Access に移行済み）
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS rate_limits;
