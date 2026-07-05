/** 受付状態（在庫・決済準備）の共通判定 */

export function resolveReceptionStatus(data) {
  if (data?._error) {
    return {
      key: 'error',
      label: '接続エラー',
      notice: '在庫情報の取得に失敗しました。しばらくしてからお試しください。',
      submitLabel: '接続できません',
      closed: true,
      badgeClass: 'error',
    };
  }

  const stock = Number(data?.stock ?? 0);
  if (data?.sold_out || stock <= 0) {
    return {
      key: 'closed',
      label: '受付終了',
      notice: '現在、予約の受付を終了しております。',
      submitLabel: '受付終了',
      closed: true,
      badgeClass: 'sold-out',
    };
  }

  if (!data?.checkout_enabled) {
    return {
      key: 'preparing',
      label: '準備中',
      notice: '決済の準備中です。しばらくしてからお試しください。',
      submitLabel: '準備中',
      closed: true,
      badgeClass: 'preparing',
    };
  }

  const unitPrice = Number(data?.unit_price ?? 0);
  if (unitPrice <= 0) {
    return {
      key: 'preparing',
      label: '準備中',
      notice: '価格設定の準備中です。しばらくしてからお試しください。',
      submitLabel: '準備中',
      closed: true,
      badgeClass: 'preparing',
    };
  }

  return {
    key: 'open',
    label: '受付中',
    stockLabel: `残り ${stock.toLocaleString('ja-JP')} 本`,
    notice: '',
    submitLabel: 'お支払いへ進む',
    closed: false,
    badgeClass: 'open',
  };
}

/** カートページ: 送信ボタン・数量・案内の更新 */
export function applyCartReceptionUI(data, { submitBtn, noticeEl, qtyMinus, qtyPlus, qty, maxStock }) {
  const state = resolveReceptionStatus(data);
  if (submitBtn) {
    submitBtn.disabled = state.closed;
    submitBtn.textContent = state.submitLabel;
  }
  if (noticeEl) {
    noticeEl.style.display = state.notice ? 'block' : 'none';
    noticeEl.textContent = state.notice;
  }
  if (qtyMinus) qtyMinus.disabled = state.closed || qty <= 1;
  if (qtyPlus) qtyPlus.disabled = state.closed || qty >= maxStock;
  return state;
}
