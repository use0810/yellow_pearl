/** Worker・管理画面・カートで共有するドメイン定数・計算 */

export const PRODUCT_ID = 'yellow-pearl';
export const PRODUCT_NAME = 'Yellow Pearl（イエローパール）';

export const ORDER_STATUS_RESERVED = '予約';
export const ORDER_STATUS_DONE = '済み';
export const ORDER_STATUS_CANCELLED = 'キャンセル';
export const ORDER_STATUSES = [ORDER_STATUS_RESERVED, ORDER_STATUS_DONE, ORDER_STATUS_CANCELLED];

export const FULFILLMENT_LABELS = {
  [ORDER_STATUS_RESERVED]: '未発送',
  [ORDER_STATUS_DONE]: '発送済',
  [ORDER_STATUS_CANCELLED]: 'キャンセル',
};

export const PAYMENT_UNPAID = '未決済';
export const PAYMENT_PAID = '決済済';
export const PAYMENT_FAILED = '失敗';
export const PAYMENT_CANCELLED = '取消';
export const PAYMENT_REFUNDED = '返金済';

export const MAX_ORDER_QTY = 5;

/** フリガナ（カタカナ） */
export const KANA_PATTERN = /^[ァ-ヴー・]+$/;

export const BOOKKEEPING_ORDER_FILTER =
  `archived_at IS NULL AND status != '${ORDER_STATUS_CANCELLED}' AND payment_status = '${PAYMENT_PAID}'`;

/** 一覧・集計から除外するアーカイブ済み行 */
export const ORDER_NOT_ARCHIVED = 'archived_at IS NULL';

/** 旧管理者キャンセル矯正 — migrate-payment-cancelled.sql と同等（一括マイグレーション専用） */
export const LEGACY_ADMIN_CANCEL_PREDICATE =
  `status = '${ORDER_STATUS_CANCELLED}' AND payment_status = '${PAYMENT_FAILED}' AND stripe_session_id IS NOT NULL`;

/** validateReserveFields の error を cart フォーム field id にマップ */
export function reserveValidationFieldId(error) {
  const map = {
    'フリガナは必須です': 'last-name-kana',
    'フリガナはカタカナで入力してください': 'last-name-kana',
    'メールアドレスの形式が正しくありません': 'email',
    '郵便番号が正しくありません': 'postal',
    '電話番号が正しくありません': 'phone',
    '都道府県が不正です': 'prefecture',
    '必須項目が不足しています': 'last-name',
  };
  return map[error] ?? null;
}

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

/** 予約フォーム入力のサーバー／クライアント共通検証 */
export function validateReserveFields(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON' };

  const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
  const lastNameKana = body.last_name_kana || '';
  const firstNameKana = body.first_name_kana || '';

  if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
    return { error: '必須項目が不足しています' };
  }
  if (!lastNameKana || !firstNameKana) {
    return { error: 'フリガナは必須です' };
  }
  if (!KANA_PATTERN.test(lastNameKana) || !KANA_PATTERN.test(firstNameKana)) {
    return { error: 'フリガナはカタカナで入力してください' };
  }
  if (!PREFECTURES.includes(prefecture)) {
    return { error: '都道府県が不正です' };
  }
  if (
    last_name.length > MAX_LEN.name || first_name.length > MAX_LEN.name ||
    lastNameKana.length > MAX_LEN.name || firstNameKana.length > MAX_LEN.name ||
    email.length > MAX_LEN.email || phone.length > MAX_LEN.phone ||
    postal.length > MAX_LEN.postal || address1.length > MAX_LEN.address ||
    (body.address2 || '').length > MAX_LEN.address ||
    (body.note || '').length > MAX_LEN.note
  ) {
    return { error: '入力が長すぎます' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'メールアドレスの形式が正しくありません' };
  }
  const postalDigits = String(postal).replace(/\D/g, '');
  if (postalDigits.length !== 7) {
    return { error: '郵便番号が正しくありません' };
  }
  const phoneDigits = String(phone).replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return { error: '電話番号が正しくありません' };
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1 || qty > MAX_ORDER_QTY) {
    return { error: '数量が不正です' };
  }

  return {
    data: {
      last_name,
      first_name,
      email,
      phone,
      postal,
      prefecture,
      address1,
      address2: body.address2 || '',
      note: body.note || '',
      last_name_kana: lastNameKana,
      first_name_kana: firstNameKana,
      qty,
    },
  };
}

/** 管理画面: 決済×予約ステータスの要約ラベル */
export function summarizeOrderState(order) {
  const status = order?.status || ORDER_STATUS_RESERVED;
  const pay = order?.payment_status || PAYMENT_UNPAID;

  if (status === ORDER_STATUS_CANCELLED) {
    if (pay === PAYMENT_REFUNDED) return { text: 'キャンセル（返金済）', className: 'summary-refunded' };
    if (pay === PAYMENT_PAID) return { text: 'キャンセル（入金済・要確認）', className: 'summary-cancelled' };
    if (pay === PAYMENT_CANCELLED) return { text: 'キャンセル（管理者）', className: 'summary-cancelled' };
    if (pay === PAYMENT_FAILED) return { text: 'キャンセル（未入金）', className: 'summary-cancelled' };
    return { text: 'キャンセル', className: 'summary-cancelled' };
  }
  if (pay === PAYMENT_PAID && status === ORDER_STATUS_RESERVED) {
    return { text: '入金済・未発送', className: 'summary-paid-ready' };
  }
  if (pay === PAYMENT_PAID && status === ORDER_STATUS_DONE) {
    return { text: '入金済・発送済', className: 'summary-done' };
  }
  if (pay === PAYMENT_UNPAID && status === ORDER_STATUS_RESERVED) {
    return { text: '未入金（決済待ち）', className: 'summary-unpaid' };
  }
  if (pay === PAYMENT_FAILED) {
    return { text: '決済未完了', className: 'summary-cancelled' };
  }
  if (pay === PAYMENT_REFUNDED) {
    return { text: '返金済', className: 'summary-refunded' };
  }
  return {
    text: `${pay}・${FULFILLMENT_LABELS[status] || status}`,
    className: 'summary-unknown',
  };
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

export function calcShippingMargin(shippingIncome, actualShipping) {
  return (shippingIncome ?? 0) - (actualShipping ?? 0);
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
