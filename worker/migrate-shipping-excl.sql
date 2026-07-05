-- shipping_rates.fee を税込 → 税抜へ換算（商品単価と同じ入力方式）
-- 旧: 税込で保存 → splitTaxInclusive と同等の floor 換算
-- 税率 0% の行はそのまま
-- デプロイ前に一度だけ実行（既存注文 orders.shipping_fee は変更しない）
UPDATE shipping_rates
SET fee = (fee * 100 / (100 + (
  SELECT COALESCE(shipping_tax_rate, 10)
  FROM inventory
  WHERE product_id = 'yellow-pearl'
)))
WHERE fee > 0
  AND (
    SELECT COALESCE(shipping_tax_rate, 10)
    FROM inventory
    WHERE product_id = 'yellow-pearl'
  ) > 0;
