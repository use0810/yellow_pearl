/** トップページ用: 在庫 API 取得と予約ボタン制御 */

import { calcOrderAmount } from './domain.js';
import { resolveReceptionStatus } from './reception-status.js';

/** ローカルで Worker 未起動時の見た目確認用（本番の現行価格に合わせる） */
const LOCAL_PREVIEW_STOCK = {
  stock: 1000,
  sold_out: false,
  unit_price: 4630,
  tax_rate: 8,
  checkout_enabled: true,
};

function isLocalPreviewHost() {
  if (typeof location === 'undefined') return false;
  if (location.protocol === 'file:') return true;
  return /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
}

function formatYen(n) {
  return Number(n ?? 0).toLocaleString('ja-JP');
}

function applyLandingPrice(data, priceEl) {
  if (!priceEl) return;
  if (data?._error) {
    priceEl.textContent = '—';
    return;
  }
  const unitPrice = Number(data?.unit_price ?? 0);
  const taxRate = Number(data?.tax_rate ?? 0);
  if (unitPrice <= 0) {
    priceEl.textContent = '—';
    return;
  }
  const { subtotal, taxAmount } = calcOrderAmount(unitPrice, 1, taxRate, 0, 0);
  priceEl.textContent = `${formatYen(subtotal + taxAmount)}円 (税込・送料別途)`;
}

function disableReserveButtons(btns, label) {
  btns.forEach((btn) => {
    if (!btn) return;
    btn.textContent = label;
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.4';
    btn.removeAttribute('href');
  });
}

/**
 * @param {object} data - /api/stock レスポンス
 * @param {{ displayEl: HTMLElement, remainingEl: HTMLElement, buttons: HTMLElement[], priceEl?: HTMLElement }} ui
 */
export function applyLandingStockUI(data, { displayEl, remainingEl, buttons, priceEl }) {
  applyLandingPrice(data, priceEl);
  const state = resolveReceptionStatus(data);

  if (state.key === 'open') {
    displayEl.textContent = state.stockLabel;
    displayEl.style.color = '';
    remainingEl.style.display = 'block';
    return;
  }

  displayEl.textContent = state.label;
  displayEl.style.color = 'rgba(232,217,176,0.4)';
  remainingEl.style.display = 'none';
  disableReserveButtons(buttons, state.key === 'error' ? '接続できません' : state.label);
}

export async function loadLandingStock(origin, ui) {
  try {
    const res = await fetch(`${origin}/api/stock`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '在庫取得に失敗');
    applyLandingStockUI(data, ui);
  } catch (e) {
    console.warn('在庫APIに接続できませんでした:', e);
    if (isLocalPreviewHost()) {
      console.info('ローカル確認用の仮データを表示しています（Worker 未接続）');
      applyLandingStockUI(LOCAL_PREVIEW_STOCK, ui);
      return;
    }
    applyLandingStockUI({ _error: true }, ui);
  }
}
