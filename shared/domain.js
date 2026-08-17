/** Worker・管理画面・カートで共有するドメイン定数・計算 */

export const PRODUCT_ID = 'yellow-pearl';
export const PRODUCT_NAME = '郷のきみイエローパール(Yellow Pearl)';

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

export const MAX_ORDER_QTY = 50;

/** Stripe Dashboard（本番）— 管理画面リンク用 */
export const STRIPE_DASHBOARD = {
  payments: 'https://dashboard.stripe.com/payments',
  payouts: 'https://dashboard.stripe.com/payouts',
  balance: 'https://dashboard.stripe.com/balance/overview',
  reports: 'https://dashboard.stripe.com/reports/hub',
};

export function isStripeLiveResourceId(id) {
  return typeof id === 'string' && id.length > 0 && id.includes('_live_');
}

/** 本番 Stripe Dashboard の決済詳細 URL（決済済・返金済のみ。テスト ID は null） */
export function stripeLiveDashboardPaymentUrl({ paymentIntentId, sessionId, paymentStatus }) {
  if (paymentStatus !== PAYMENT_PAID && paymentStatus !== PAYMENT_REFUNDED) return null;
  const pi = paymentIntentId || '';
  const cs = sessionId || '';
  if (isStripeLiveResourceId(pi)) {
    return `https://dashboard.stripe.com/payments/${encodeURIComponent(pi)}`;
  }
  if (isStripeLiveResourceId(cs)) {
    return `https://dashboard.stripe.com/checkout/sessions/${encodeURIComponent(cs)}`;
  }
  return null;
}

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
    '入力が長すぎます': 'last-name',
    '数量が不正です': 'quantity',
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

/** 発送先・連絡先の検証（数量なし。管理画面の訂正用） */
export function validateOrderContactFields(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON' };

  const last_name = typeof body.last_name === 'string' ? body.last_name.trim() : '';
  const first_name = typeof body.first_name === 'string' ? body.first_name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const postal = typeof body.postal === 'string' ? body.postal.trim() : '';
  const prefecture = typeof body.prefecture === 'string' ? body.prefecture.trim() : '';
  const address1 = typeof body.address1 === 'string' ? body.address1.trim() : '';
  const address2 = typeof body.address2 === 'string' ? body.address2.trim() : '';
  const lastNameKana = typeof body.last_name_kana === 'string' ? body.last_name_kana.trim() : '';
  const firstNameKana = typeof body.first_name_kana === 'string' ? body.first_name_kana.trim() : '';

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
    address2.length > MAX_LEN.address
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

  return {
    data: {
      last_name,
      first_name,
      email,
      phone,
      postal,
      prefecture,
      address1,
      address2,
      last_name_kana: lastNameKana,
      first_name_kana: firstNameKana,
    },
  };
}

/** 予約フォーム入力のサーバー／クライアント共通検証 */
export function validateReserveFields(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON' };

  const contact = validateOrderContactFields(body);
  if (contact.error) return contact;

  if ((body.note || '').length > MAX_LEN.note) {
    return { error: '入力が長すぎます' };
  }

  const qty = parseInt(body.quantity ?? 1, 10);
  if (isNaN(qty) || qty < 1 || qty > MAX_ORDER_QTY) {
    return { error: '数量が不正です' };
  }

  return {
    data: {
      ...contact.data,
      note: body.note || '',
      qty,
    },
  };
}

/** 管理画面: 決済×予約ステータスの要約ラベル */
/** 自動キャンセルの理由（order_events の event_type → 管理画面の表示） */
export const CANCEL_REASON_LABELS = {
  payment_failed_customer_abort: 'お客様が決済を中断',
  payment_failed_expired: '決済ページの期限切れ',
  payment_failed_async: '振込が不成立',
  payment_failed_cleanup_limit: '振込期限切れ・14日経過',
  payment_failed_orphan: 'システムエラー・決済が始まらず',
  payment_failed_session_create: 'システムエラー・決済ページ作成失敗',
  payment_failed_session_link: 'システムエラー・予約の更新失敗',
};

/** 誰の操作・どの経路でキャンセルされたかを一言で返す */
export function cancelReasonLabel(order) {
  const pay = order?.payment_status;
  if (pay === PAYMENT_REFUNDED) return '管理者が取消・返金済';
  if (pay === PAYMENT_CANCELLED) return '管理者が取消';
  if (pay === PAYMENT_PAID) return '入金済のまま取消・要確認';
  if (pay === PAYMENT_FAILED) {
    return CANCEL_REASON_LABELS[order?.payment_fail_reason] || '理由不明・未入金';
  }
  return '';
}

const ACCOUNT_TYPE_LABELS = { futsu: '普通', toza: '当座' };

/** orders.bank_transfer_info（Stripe の振込手順 JSON）を読む */
export function parseBankTransferInfo(order) {
  if (!order?.bank_transfer_info) return null;
  try {
    const info = typeof order.bank_transfer_info === 'string'
      ? JSON.parse(order.bank_transfer_info)
      : order.bank_transfer_info;
    return info?.account_number ? info : null;
  } catch {
    return null;
  }
}

/** 振込先を「項目: 値」の行にする（メール本文・管理画面で共用） */
export function bankTransferLines(info) {
  return [
    ['銀行名', `${info.bank_name ?? '-'}${info.bank_code ? `（${info.bank_code}）` : ''}`],
    ['支店名', `${info.branch_name ?? '-'}${info.branch_code ? `（${info.branch_code}）` : ''}`],
    ['預金種目', ACCOUNT_TYPE_LABELS[info.account_type] ?? info.account_type ?? '普通'],
    ['口座番号', info.account_number],
    ['口座名義', info.account_holder_name ?? '-'],
  ];
}

export function summarizeOrderState(order) {
  const status = order?.status || ORDER_STATUS_RESERVED;
  const pay = order?.payment_status || PAYMENT_UNPAID;

  if (status === ORDER_STATUS_CANCELLED) {
    const className = pay === PAYMENT_REFUNDED ? 'summary-refunded' : 'summary-cancelled';
    return { text: `キャンセル（${cancelReasonLabel(order) || '詳細不明'}）`, className };
  }
  if (pay === PAYMENT_PAID && status === ORDER_STATUS_RESERVED) {
    return { text: '入金済・未発送', className: 'summary-paid-ready' };
  }
  if (pay === PAYMENT_PAID && status === ORDER_STATUS_DONE) {
    return { text: '入金済・発送済', className: 'summary-done' };
  }
  if (pay === PAYMENT_UNPAID && status === ORDER_STATUS_RESERVED) {
    return {
      text: order?.bank_transfer_pending ? '振込待ち（確認済・最大14日）' : '振込待ち（最大14日）',
      className: 'summary-bank-pending',
    };
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

export function calcOrderAmount(unitPrice, qty, taxRate, shippingFeeExcl, shippingTaxRate) {
  const subtotal = unitPrice * qty;
  const taxAmount = Math.floor(subtotal * taxRate / 100);
  const shippingExcl = shippingFeeExcl ?? 0;
  const shippingTaxAmount = shippingExcl > 0 && shippingTaxRate > 0
    ? Math.floor(shippingExcl * shippingTaxRate / 100)
    : 0;
  const shippingFeeIncl = shippingExcl + shippingTaxAmount;
  const totalAmount = subtotal + taxAmount + shippingFeeIncl;
  return {
    subtotal,
    taxAmount,
    shippingFeeIncl,
    shippingExcl,
    shippingTaxAmount,
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
