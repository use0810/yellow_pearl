/** トップページ用: 在庫 API 取得と予約ボタン制御 */

import { resolveReceptionStatus } from './reception-status.js';

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
 * @param {{ displayEl: HTMLElement, remainingEl: HTMLElement, buttons: HTMLElement[] }} ui
 */
export function applyLandingStockUI(data, { displayEl, remainingEl, buttons }) {
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
    applyLandingStockUI({ _error: true }, ui);
  }
}
