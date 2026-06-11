-- 不要になった管理用テーブルを削除（認証は Cloudflare Access に移行済み）
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS rate_limits;

-- 単価カラム（既存DB向け。エラーなら追加済み）
ALTER TABLE inventory ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;

-- 送料テーブル
CREATE TABLE IF NOT EXISTS shipping_rates (
  prefecture TEXT PRIMARY KEY,
  fee INTEGER NOT NULL DEFAULT 0
);

-- 注文の金額カラム（既存DB向け。エラーなら追加済み）
ALTER TABLE orders ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN total_amount INTEGER NOT NULL DEFAULT 0;

-- 47都道府県の初期データ
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('北海道', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('青森県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('岩手県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('宮城県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('秋田県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('山形県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('福島県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('茨城県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('栃木県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('群馬県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('埼玉県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('千葉県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('東京都', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('神奈川県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('新潟県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('富山県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('石川県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('福井県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('山梨県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('長野県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('岐阜県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('静岡県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('愛知県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('三重県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('滋賀県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('京都府', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('大阪府', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('兵庫県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('奈良県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('和歌山県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('鳥取県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('島根県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('岡山県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('広島県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('山口県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('徳島県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('香川県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('愛媛県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('高知県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('福岡県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('佐賀県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('長崎県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('熊本県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('大分県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('宮崎県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('鹿児島県', 0);
INSERT OR IGNORE INTO shipping_rates (prefecture, fee) VALUES ('沖縄県', 0);

-- 予約ステータス・特記事項（既存DB向け。エラーなら追加済み）
ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT '予約';
ALTER TABLE orders ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';

-- 税率・消費税額（既存DB向け。エラーなら追加済み）
ALTER TABLE inventory ADD COLUMN tax_rate INTEGER NOT NULL DEFAULT 10;
ALTER TABLE orders ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0;
