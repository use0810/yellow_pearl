/** Worker・管理画面・カートで共有するドメイン定数・計算 */

export const PRODUCT_ID = 'yellow-pearl';
export const PRODUCT_NAME = 'Yellow Pearl（イエローパール）';
export const ORDER_STATUSES = ['予約', '済み', 'キャンセル'];

export const PAYMENT_UNPAID = '未決済';
export const PAYMENT_PAID = '決済済';
export const PAYMENT_FAILED = '失敗';

export const MAX_ORDER_QTY = 5;

export const BOOKKEEPING_ORDER_FILTER =
  `status != 'キャンセル' AND payment_status = '${PAYMENT_PAID}'`;

export const MAX_LEN = {
  name: 50,
  email: 100,
  phone: 20,
  postal: 10,
  address: 200,
  note: 500,
  admin_note: 500,
};

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

export const SHIPPING_REGIONS = [
  { id: 'hokkaido', name: '北海道', prefectures: ['北海道'] },
  { id: 'okinawa', name: '沖縄', prefectures: ['沖縄県'] },
  { id: 'tohoku', name: '東北地方', prefectures: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'] },
  { id: 'kanto', name: '関東地方', prefectures: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'] },
  { id: 'chubu', name: '中部地方', prefectures: ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'] },
  { id: 'kinki', name: '近畿地方', prefectures: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'] },
  { id: 'chugoku', name: '中国地方', prefectures: ['鳥取県', '島根県', '岡山県', '広島県', '山口県'] },
  { id: 'shikoku', name: '四国地方', prefectures: ['徳島県', '香川県', '愛媛県', '高知県'] },
  { id: 'kyushu', name: '九州地方', prefectures: ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県'] },
];

/** Checkout 時点で在庫確保済み、または決済済み */
export function orderHoldsStock(paymentStatus) {
  return paymentStatus === PAYMENT_UNPAID || paymentStatus === PAYMENT_PAID;
}

export function splitTaxInclusive(amountIncl, taxRate) {
  if (amountIncl <= 0 || taxRate <= 0) {
    return { excl: amountIncl, tax: 0, incl: amountIncl };
  }
  const excl = Math.floor(amountIncl * 100 / (100 + taxRate));
  const tax = amountIncl - excl;
  return { excl, tax, incl: amountIncl };
}

export function calcOrderAmount(unitPrice, qty, taxRate, shippingFeeIncl, shippingTaxRate) {
  const subtotal = unitPrice * qty;
  const taxAmount = Math.floor(subtotal * taxRate / 100);
  const shipping = splitTaxInclusive(shippingFeeIncl, shippingTaxRate);
  const totalAmount = subtotal + taxAmount + shipping.incl;
  return {
    subtotal,
    taxAmount,
    shippingFeeIncl: shipping.incl,
    shippingExcl: shipping.excl,
    shippingTaxAmount: shipping.tax,
    totalAmount,
  };
}

export function findShippingRegion(id) {
  return SHIPPING_REGIONS.find((r) => r.id === id);
}

export function getShippingRegionsFromMap(prefectureMap) {
  return SHIPPING_REGIONS.map((region) => ({
    id: region.id,
    name: region.name,
    prefectures: region.prefectures,
    fee: prefectureMap[region.prefectures[0]] ?? 0,
  }));
}

export function sumBookkeepingMonths(months) {
  return months.reduce((acc, m) => ({
    order_count: acc.order_count + m.order_count,
    total_quantity: acc.total_quantity + m.total_quantity,
    product_subtotal: acc.product_subtotal + m.product_subtotal,
    tax_amount: acc.tax_amount + m.tax_amount,
    shipping_tax_amount: acc.shipping_tax_amount + m.shipping_tax_amount,
    shipping_income: acc.shipping_income + m.shipping_income,
    total_amount: acc.total_amount + m.total_amount,
    actual_shipping: acc.actual_shipping + m.actual_shipping,
  }), {
    order_count: 0,
    total_quantity: 0,
    product_subtotal: 0,
    tax_amount: 0,
    shipping_tax_amount: 0,
    shipping_income: 0,
    total_amount: 0,
    actual_shipping: 0,
  });
}
