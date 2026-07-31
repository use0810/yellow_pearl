/** Google Analytics (GA4) — 公開ページ共通設定 */
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag('js', new Date());
gtag('config', 'G-WR46VTNMV6');

const GA_ITEM = {
  item_id: 'yellow-pearl',
  item_name: '郷のきみイエローパール',
  item_brand: 'Yellow Pearl',
  item_category: 'トウモロコシ',
};

function trackEvent(name, params) {
  if (typeof gtag !== 'function') return;
  gtag('event', name, params);
}

/** Stripe Checkout へ進む直前（予約作成成功時） */
function trackBeginCheckout({ orderId, value, quantity }) {
  const qty = Number(quantity) || 1;
  const val = Number(value) || 0;
  trackEvent('begin_checkout', {
    currency: 'JPY',
    value: val,
    items: [{ ...GA_ITEM, quantity: qty, price: qty > 0 ? Math.round(val / qty) : val }],
    transaction_id: orderId || undefined,
  });
}

/** 決済完了（カード等の即時支払い）。同一 transaction_id の二重送信を防ぐ */
function trackPurchase({ orderId, value, quantity }) {
  if (!orderId) return;
  const key = `yp_ga_purchase_${orderId}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    /* sessionStorage 不可でも送信は続ける */
  }
  const qty = Number(quantity) || 1;
  const val = Number(value) || 0;
  trackEvent('purchase', {
    transaction_id: orderId,
    currency: 'JPY',
    value: val,
    items: [{ ...GA_ITEM, quantity: qty, price: qty > 0 ? Math.round(val / qty) : val }],
  });
}

/** 銀行振込など、案内表示時点（入金前） */
function trackBankTransferPending({ orderId, value, quantity }) {
  const qty = Number(quantity) || 1;
  const val = Number(value) || 0;
  trackEvent('add_payment_info', {
    currency: 'JPY',
    value: val,
    payment_type: 'bank_transfer',
    items: [{ ...GA_ITEM, quantity: qty, price: qty > 0 ? Math.round(val / qty) : val }],
    transaction_id: orderId || undefined,
  });
}

window.ypTrack = {
  beginCheckout: trackBeginCheckout,
  purchase: trackPurchase,
  bankTransferPending: trackBankTransferPending,
};
