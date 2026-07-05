-- 旧管理者キャンセル（payment_status='失敗'）を '取消' に矯正
-- stripe_session_id が NULL の行は Stripe 失敗由来の可能性があるため対象外
-- デプロイ前に migrate-audit.sql の後に実行すること
UPDATE orders
SET payment_status = '取消'
WHERE status = 'キャンセル'
  AND payment_status = '失敗'
  AND stripe_session_id IS NOT NULL;
