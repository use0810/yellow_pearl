      import {
  ORDER_STATUSES,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_UNPAID,
  SHIPPING_REGIONS,
  orderHoldsStock,
  sumBookkeepingMonths,
} from '/shared/domain.js';

      const WORKER_URL = window.location.origin;
      const SCREEN_TITLES = {
        products: '商品管理',
        orders: '予約管理',
        stats: '統計',
        bookkeeping: '帳簿・申告',
      };
      let orderFilter = 'active';
      let activeScreen = 'products';
      let accessLogoutUrl = null;
      let bookkeepingData = null;

      function yen(n) {
        return `¥${formatYen(n)}`;
      }

      function initBookkeepingYearSelect() {
        const sel = document.getElementById('bk-year');
        if (!sel || sel.options.length) return;
        const now = new Date().getFullYear();
        for (let y = now; y >= now - 5; y -= 1) {
          const opt = document.createElement('option');
          opt.value = String(y);
          opt.textContent = `${y}年`;
          sel.appendChild(opt);
        }
      }

      function getBookkeepingYear() {
        return parseInt(document.getElementById('bk-year').value, 10) || new Date().getFullYear();
      }

      function renderBookkeepingSummary(totals) {
        document.getElementById('bk-sum-product').textContent = yen(totals.product_subtotal);
        document.getElementById('bk-sum-tax').textContent = yen(totals.tax_amount);
        document.getElementById('bk-sum-shipping-tax').textContent = yen(totals.shipping_tax_amount ?? 0);
        document.getElementById('bk-sum-shipping-in').textContent = yen(totals.shipping_income);
        document.getElementById('bk-sum-total').textContent = yen(totals.total_amount);
        document.getElementById('bk-sum-shipping-out').textContent = yen(totals.actual_shipping);
        const marginEl = document.getElementById('bk-sum-margin');
        const margin = totals.shipping_margin ?? (totals.shipping_income - totals.actual_shipping);
        marginEl.textContent = yen(margin);
        marginEl.classList.toggle('positive', margin >= 0);
        marginEl.classList.toggle('negative', margin < 0);
      }

      function renderBookkeepingTable(months) {
        const tbody = document.getElementById('bk-monthly-body');
        tbody.innerHTML = months.map((m) => `<tr data-ym="${esc(m.year_month)}">
          <td>${m.month}月</td>
          <td class="num">${m.order_count}</td>
          <td class="num">${formatYen(m.product_subtotal)}</td>
          <td class="num">${formatYen(m.tax_amount)}</td>
          <td class="num">${formatYen(m.shipping_tax_amount ?? 0)}</td>
          <td class="num">${formatYen(m.shipping_income)}</td>
          <td class="num">${formatYen(m.total_amount)}</td>
          <td class="num">
            <input type="number" min="0" class="bk-actual-shipping" value="${m.actual_shipping}" aria-label="${m.month}月の実配送費" />
          </td>
          <td>
            <input type="text" class="bk-note" value="${esc(m.note)}" placeholder="例: ヤマト請求書" aria-label="${m.month}月のメモ" />
          </td>
        </tr>`).join('');
      }

      async function loadBookkeeping() {
        const year = getBookkeepingYear();
        const data = await api(`/api/admin/bookkeeping?year=${year}`);
        bookkeepingData = data;
        renderBookkeepingSummary(data.totals);
        renderBookkeepingTable(data.months);
      }

      function collectBookkeepingExpenses() {
        return [...document.querySelectorAll('#bk-monthly-body tr[data-ym]')].map((row) => ({
          year_month: row.dataset.ym,
          actual_shipping: parseInt(row.querySelector('.bk-actual-shipping').value, 10) || 0,
          note: row.querySelector('.bk-note').value.trim(),
        }));
      }

      async function saveBookkeepingExpenses() {
        const errEl = document.getElementById('bk-error');
        const okEl = document.getElementById('bk-success');
        const btn = document.getElementById('bk-save-expenses-btn');
        errEl.textContent = '';
        okEl.textContent = '';
        btn.disabled = true;
        try {
          const data = await api('/api/admin/bookkeeping/expenses', {
            method: 'PUT',
            body: JSON.stringify({
              year: getBookkeepingYear(),
              expenses: collectBookkeepingExpenses(),
            }),
          });
          bookkeepingData = { ...bookkeepingData, months: data.months, totals: data.totals };
          renderBookkeepingSummary(data.totals);
          renderBookkeepingTable(data.months);
          okEl.textContent = '実配送費を保存しました';
        } catch (err) {
          errEl.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      }

      async function downloadBookkeepingCsv() {
        const year = getBookkeepingYear();
        const res = await fetch(
          `${WORKER_URL}/api/admin/bookkeeping/export.csv?year=${year}`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'CSV の取得に失敗しました');
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `yellow-pearl-bookkeeping-${year}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      function getBookkeepingViewData() {
        const expenses = collectBookkeepingExpenses();
        const months = (bookkeepingData?.months ?? []).map((m, i) => {
          const actualShipping = expenses[i]?.actual_shipping ?? m.actual_shipping;
          return {
            ...m,
            actual_shipping: actualShipping,
            note: expenses[i]?.note ?? m.note,
            shipping_margin: m.shipping_income - actualShipping,
          };
        });
        const totals = sumBookkeepingMonths(months);
        totals.shipping_margin = totals.shipping_income - totals.actual_shipping;
        return { year: getBookkeepingYear(), months, totals };
      }

      function printBookkeepingPdf() {
        if (!bookkeepingData) return;
        const { year, months, totals } = getBookkeepingViewData();
        const margin = totals.shipping_margin ?? (totals.shipping_income - totals.actual_shipping);
        const rows = months.map((m) => `<tr>
          <td>${m.month}月</td>
          <td style="text-align:right">${m.order_count}</td>
          <td style="text-align:right">${formatYen(m.product_subtotal)}</td>
          <td style="text-align:right">${formatYen(m.tax_amount)}</td>
          <td style="text-align:right">${formatYen(m.shipping_tax_amount ?? 0)}</td>
          <td style="text-align:right">${formatYen(m.shipping_income)}</td>
          <td style="text-align:right">${formatYen(m.total_amount)}</td>
          <td style="text-align:right">${formatYen(m.actual_shipping)}</td>
          <td>${esc(m.note)}</td>
        </tr>`).join('');
        const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
          <title>Yellow Pearl 帳簿 ${year}年</title>
          <style>
            body { font-family: sans-serif; font-size: 12px; color: #111; padding: 24px; }
            h1 { font-size: 18px; margin: 0 0 4px; }
            .meta { color: #666; margin-bottom: 20px; }
            .summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 20px; }
            .summary div { border: 1px solid #ccc; padding: 8px; border-radius: 4px; }
            .label { font-size: 10px; color: #666; }
            .val { font-size: 14px; font-weight: bold; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
            th, td { border: 1px solid #ccc; padding: 6px 8px; }
            th { background: #f5f5f5; text-align: left; }
            .note { font-size: 10px; color: #666; line-height: 1.5; }
            @media print { body { padding: 0; } }
          </style></head><body>
          <h1>Yellow Pearl 帳簿サマリー</h1>
          <p class="meta">${year}年 · 決済済み注文ベース · 出力日 ${new Date().toLocaleDateString('ja-JP')}</p>
          <div class="summary">
            <div><div class="label">商品売上（税抜）</div><div class="val">${yen(totals.product_subtotal)}</div></div>
            <div><div class="label">消費税（商品分）</div><div class="val">${yen(totals.tax_amount)}</div></div>
            <div><div class="label">消費税（送料分）</div><div class="val">${yen(totals.shipping_tax_amount ?? 0)}</div></div>
            <div><div class="label">送料収入（税込）</div><div class="val">${yen(totals.shipping_income)}</div></div>
            <div><div class="label">売上合計</div><div class="val">${yen(totals.total_amount)}</div></div>
            <div><div class="label">実配送費</div><div class="val">${yen(totals.actual_shipping)}</div></div>
            <div><div class="label">送料差額</div><div class="val">${yen(margin)}</div></div>
          </div>
          <table>
            <thead><tr>
              <th>月</th><th>件数</th><th>商品(税抜)</th><th>消費税(商品)</th><th>消費税(送料)</th><th>送料(税込)</th><th>合計</th><th>実配送費</th><th>メモ</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="note">※ 課税事業者向けたたき台。送料の消費税区分・Stripe手数料等は税理士にご確認ください。</p>
          </body></html>`;
        const w = window.open('', '_blank', 'noopener,noreferrer');
        if (!w) {
          alert('ポップアップを許可してください');
          return;
        }
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => w.print(), 300);
      }

      function esc(s) {
        return String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      async function api(path, options = {}) {
        let res;
        try {
          res = await fetch(`${WORKER_URL}${path}`, {
            ...options,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...options.headers },
          });
        } catch {
          throw new Error('APIに接続できません。Worker Route（yellow-pearl.com/api/*）の設定を確認してください。');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'エラーが発生しました');
        return data;
      }

      function showApp() {
        document.getElementById('auth-error').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
      }

      function showAuthError(msg) {
        document.getElementById('auth-error').style.display = 'block';
        document.getElementById('auth-error-msg').textContent = msg;
        document.getElementById('app').style.display = 'none';
      }

      async function checkAdminSession() {
        const res = await fetch(`${WORKER_URL}/api/admin/session`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.authenticated) {
          accessLogoutUrl = data.logout_url || null;
          return true;
        }
        if (res.status === 503) {
          throw new Error(data.error || '管理者認証（Cloudflare Access）が設定されていません。');
        }
        throw new Error(
          data.error || 'メールでのワンタイム認証が必要です。ログイン画面を開いてください。',
        );
      }

      function logoutAdmin() {
        if (accessLogoutUrl) {
          window.location.href = accessLogoutUrl;
          return;
        }
        window.location.reload();
      }

      function formatYen(n) {
        return Number(n ?? 0).toLocaleString('ja-JP');
      }

      function fmtNum(n) {
        return Number(n ?? 0).toLocaleString('ja-JP');
      }

      function updatePricingPreview() {
        const unitPrice = parseInt(document.getElementById('edit-unit-price').value, 10) || 0;
        const taxRate = parseInt(document.getElementById('edit-tax-rate').value, 10) || 0;
        const taxPerUnit = Math.floor(unitPrice * taxRate / 100);
        const inclPerUnit = unitPrice + taxPerUnit;
        const el = document.getElementById('pricing-preview');
        if (!el) return;
        el.innerHTML = `
          1本あたり　税抜 ${formatYen(unitPrice)} 円 ＋ 消費税（${taxRate}%） ${formatYen(taxPerUnit)} 円
          ＝ <strong>税込 ${formatYen(inclPerUnit)} 円</strong>（商品のみ・送料別）
          <span class="pricing-preview-note">Stripe には「${esc('Yellow Pearl（イエローパール）')}」と「消費税（商品・${taxRate}%）」の明細行として送信されます。</span>
        `;
      }

      ['edit-unit-price', 'edit-tax-rate'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', updatePricingPreview);
      });

      function switchScreen(name) {
        activeScreen = name;
        document.querySelectorAll('.screen').forEach((el) => {
          el.classList.toggle('active', el.id === `screen-${name}`);
        });
        document.querySelectorAll('.nav-btn').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.screen === name);
        });
        document.getElementById('screen-title').textContent = SCREEN_TITLES[name] || '';
        if (name === 'stats') loadStats().catch((err) => alert(err.message));
        if (name === 'orders') loadOrders().catch((err) => alert(err.message));
        if (name === 'bookkeeping') loadBookkeeping().catch((err) => alert(err.message));
      }

      document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchScreen(btn.dataset.screen));
      });

      function renderStats(data) {
        const chart = document.getElementById('year-bar-chart');
        const tbody = document.getElementById('stats-table-body');
        const yearly = data.yearly || [];

        if (!yearly.length) {
          chart.innerHTML = '<p class="empty-msg">昨年度までのデータがありません</p>';
          tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">データなし</td></tr>';
          return;
        }

        const maxCount = Math.max(...yearly.map((y) => y.order_count), 1);
        chart.innerHTML = yearly.map((y) => {
          const h = Math.round((y.order_count / maxCount) * 160);
          return `<div class="bar-col">
            <span class="bar-count">${y.order_count}件</span>
            <div class="bar-pillar" style="height:${h}px" title="${y.year}年: ${y.order_count}件"></div>
            <span class="bar-year">${y.year}</span>
          </div>`;
        }).join('');

        tbody.innerHTML = yearly.map((y) => `<tr>
          <td>${y.year}年度</td>
          <td class="num">${formatYen(y.order_count)}件</td>
          <td class="num">${formatYen(y.total_quantity)}本</td>
          <td class="num">¥${formatYen(y.amount)}</td>
        </tr>`).join('');
      }

      function formatRegionPrefs(prefectures) {
        return prefectures.map((p) => p.replace(/[都道府県]$/, '')).join('・');
      }

      function renderShippingGrid(regions) {
        const feeById = Object.fromEntries((regions || []).map((r) => [r.id, r.fee]));
        const grid = document.getElementById('shipping-grid');
        grid.innerHTML = SHIPPING_REGIONS.map((r) => `
          <div class="shipping-item">
            <label>
              <span class="shipping-region-name">${esc(r.name)}</span>
              <span class="shipping-region-prefs">${esc(formatRegionPrefs(r.prefectures))}</span>
            </label>
            <input type="number" min="0" data-region="${r.id}" value="${feeById[r.id] ?? 0}" />
          </div>
        `).join('');
      }

      async function loadStats() {
        const data = await api('/api/admin/stats');
        renderStats(data);
      }

      function formatAddress(o) {
        if (!o.postal && !o.prefecture && !o.address1) return '—';
        const line2 = o.address2 ? ` ${o.address2}` : '';
        return `〒${o.postal || ''} ${o.prefecture || ''}${o.address1 || ''}${line2}`.trim();
      }

      function formatContact(o) {
        if (!o.email && !o.phone) return '—';
        const kana = (o.last_name_kana || o.first_name_kana)
          ? `<br><span style="color:#888;font-size:0.8rem">${esc(o.last_name_kana)} ${esc(o.first_name_kana)}</span>`
          : '';
        const email = o.email ? `${esc(o.email)}` : '';
        const phone = o.phone ? `${o.email ? '<br>' : ''}${esc(o.phone)}` : '';
        return `${email}${phone}${kana}` || '—';
      }

      function statusPillClass(status) {
        if (status === '済み') return 'done';
        if (status === 'キャンセル') return 'cancelled';
        return 'reserved';
      }

function paymentPillClass(paymentStatus) {
  if (paymentStatus === PAYMENT_PAID) return 'payment-paid';
  if (paymentStatus === PAYMENT_FAILED) return 'payment-failed';
  return 'payment-unpaid';
}

function formatPaymentStatus(paymentStatus) {
  return paymentStatus || PAYMENT_UNPAID;
}

      function renderOpsCell(o) {
        const status = o.status || '予約';
        if (status === 'キャンセル') {
          return `<div class="ops-cell ops-cell-cancelled" data-order-id="${esc(o.order_id)}">
            <div class="ops-actions">
              <button type="button" class="btn btn-primary ops-restore-btn"
                data-order-id="${esc(o.order_id)}"
                data-payment-status="${esc(o.payment_status || PAYMENT_UNPAID)}"
                data-admin-note="${esc(o.admin_note || '')}">再予約</button>
              <button type="button" class="btn btn-danger ops-delete-btn"
                data-order-id="${esc(o.order_id)}">削除</button>
            </div>
          </div>`;
        }
        const options = ORDER_STATUSES.map((s) =>
          `<option value="${s}"${s === status ? ' selected' : ''}>${s}</option>`
        ).join('');
        return `<div class="ops-cell" data-order-id="${esc(o.order_id)}">
          <select class="ops-status">${options}</select>
          <textarea class="ops-note" placeholder="特記事項（管理者用）">${esc(o.admin_note || '')}</textarea>
          <button type="button" class="btn ops-save ops-save-btn" data-order-id="${esc(o.order_id)}">保存</button>
        </div>`;
      }

      function renderOrders(orders) {
        const tbody = document.getElementById('orders-table-body');
        const cards = document.getElementById('orders-cards');
        const emptyLabel = orderFilter === 'cancelled' ? 'キャンセルなし' : '予約なし';

        if (!orders.length) {
          tbody.innerHTML = `<tr><td colspan="9" class="empty-msg">${emptyLabel}</td></tr>`;
          cards.innerHTML = `<p class="empty-msg">${emptyLabel}</p>`;
          return;
        }

        tbody.innerHTML = orders.map((o) => {
          const note = o.note ? `<br><span style="color:#888">お客様備考: ${esc(o.note)}</span>` : '';
          const status = o.status || '予約';
          const paymentStatus = formatPaymentStatus(o.payment_status);
          return `<tr data-order-id="${esc(o.order_id)}">
            <td class="mono">${esc(o.order_id)}</td>
            <td>${esc(o.last_name)} ${esc(o.first_name)}</td>
            <td>${formatContact(o)}</td>
            <td>${esc(formatAddress(o))}${note}</td>
            <td>${o.quantity}本</td>
            <td class="num">${o.total_amount ? `¥${formatYen(o.total_amount)}` : '—'}</td>
            <td><span class="status-pill ${paymentPillClass(paymentStatus)}">${esc(paymentStatus)}</span></td>
            <td style="white-space:nowrap">${esc(o.created_at)}</td>
            <td>${renderOpsCell(o)}</td>
          </tr>`;
        }).join('');

        cards.innerHTML = orders.map((o) => {
          const status = o.status || '予約';
          const paymentStatus = formatPaymentStatus(o.payment_status);
          return `
          <article class="order-card" data-order-id="${esc(o.order_id)}">
            <div class="order-card-head">
              <div>
                <div class="order-card-name">${esc(o.last_name)} ${esc(o.first_name)}</div>
                <span class="status-pill ${statusPillClass(status)}">${esc(status)}</span>
                <span class="status-pill ${paymentPillClass(paymentStatus)}">${esc(paymentStatus)}</span>
                ${(o.last_name_kana || o.first_name_kana)
                  ? `<div style="font-size:0.8rem;color:#888">${esc(o.last_name_kana)} ${esc(o.first_name_kana)}</div>`
                  : ''}
              </div>
              <div class="order-card-id">${esc(o.order_id)}</div>
            </div>
            <dl class="order-card-dl">
              <dt>数量</dt><dd>${o.quantity}本</dd>
              <dt>合計</dt><dd>${o.total_amount ? `¥${formatYen(o.total_amount)}` : '—'}</dd>
              <dt>日時</dt><dd>${esc(o.created_at)}</dd>
              <dt>メール</dt><dd>${esc(o.email)}</dd>
              <dt>電話</dt><dd>${esc(o.phone)}</dd>
              <dt>住所</dt><dd>${esc(formatAddress(o))}</dd>
              ${o.note ? `<dt>お客様備考</dt><dd>${esc(o.note)}</dd>` : ''}
            </dl>
            ${renderOpsCell(o)}
          </article>
        `;
        }).join('');
      }

      function updateOrdersFilterUI() {
        const isCancelled = orderFilter === 'cancelled';
        document.getElementById('orders-list-title').textContent =
          isCancelled ? 'キャンセル一覧' : '予約一覧';
        document.getElementById('toggle-orders-filter-btn').textContent =
          isCancelled ? '予約一覧に戻る' : 'キャンセル一覧';
      }

      async function loadOrders() {
        const filter = orderFilter === 'cancelled' ? 'cancelled' : 'active';
        const data = await api(`/api/admin/orders?filter=${filter}`);
        updateOrdersFilterUI();
        renderOrders(data.orders ?? []);
      }

      async function saveOrder(orderId, container) {
        const status = container.querySelector('.ops-status').value;
        const adminNote = container.querySelector('.ops-note').value.trim();
        await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
          method: 'PUT',
          body: JSON.stringify({ status, admin_note: adminNote }),
        });
        await loadOrders();
        await loadDashboard();
      }

      async function restoreOrder(btn) {
        const orderId = btn.dataset.orderId;
  const ps = btn.dataset.paymentStatus || PAYMENT_UNPAID;
  const msg = orderHoldsStock(ps)
    ? 'この予約を再予約（予約）に戻しますか？在庫が減ります。'
    : 'この予約を再予約（予約）に戻しますか？（決済失敗のため在庫は変わりません）';
        if (!confirm(msg)) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              status: '予約',
              admin_note: btn.dataset.adminNote || '',
            }),
          });
          orderFilter = 'active';
          await loadOrders();
          await loadDashboard();
        } finally {
          btn.disabled = false;
        }
      }

      async function deleteOrder(btn) {
        const orderId = btn.dataset.orderId;
        if (!confirm('このキャンセル予約を完全に削除しますか？この操作は取り消せません。')) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
            method: 'DELETE',
          });
          await loadOrders();
          await loadDashboard();
        } finally {
          btn.disabled = false;
        }
      }

      function handleOrdersClick(e) {
        const restoreBtn = e.target.closest('.ops-restore-btn');
        if (restoreBtn) {
          restoreOrder(restoreBtn).catch((err) => alert(err.message));
          return;
        }
        const deleteBtn = e.target.closest('.ops-delete-btn');
        if (deleteBtn) {
          deleteOrder(deleteBtn).catch((err) => alert(err.message));
          return;
        }
        const saveBtn = e.target.closest('.ops-save-btn');
        if (!saveBtn) return;
        const container = saveBtn.closest('.ops-cell');
        if (!container) return;
        saveBtn.disabled = true;
        saveOrder(saveBtn.dataset.orderId, container)
          .catch((err) => alert(err.message))
          .finally(() => { saveBtn.disabled = false; });
      }

      function renderDashboard(data) {
        const inv = data?.inventory ?? {};
        document.getElementById('stat-sold').textContent = fmtNum(data?.sold);
        document.getElementById('stat-stock').textContent = fmtNum(inv.stock);
        document.getElementById('stat-orders').textContent = fmtNum(data?.order_count);

        document.getElementById('edit-stock').value = inv.stock ?? 0;
        document.getElementById('edit-unit-price').value = inv.unit_price ?? 0;
        document.getElementById('edit-tax-rate').value = inv.tax_rate ?? 10;
        document.getElementById('edit-shipping-tax-rate').value = inv.shipping_tax_rate ?? 10;
        document.getElementById('edit-sold-out').checked = !!inv.sold_out;

        const badge = document.getElementById('status-badge');
        if (inv.sold_out || inv.stock <= 0) {
          badge.textContent = '受付終了';
          badge.classList.add('sold-out');
        } else {
          badge.textContent = '受付中';
          badge.classList.remove('sold-out');
        }

        updatePricingPreview();
        renderShippingGrid(data.shipping_regions ?? []);
        if (activeScreen === 'orders') loadOrders().catch(() => {});
      }

      async function loadDashboard() {
        const data = await api('/api/admin/dashboard');
        renderDashboard(data);
        document.getElementById('app').style.display = 'flex';
      }

      document.getElementById('refresh-btn').addEventListener('click', async () => {
        try {
          await loadDashboard();
          if (activeScreen === 'stats') await loadStats();
          if (activeScreen === 'orders') await loadOrders();
          if (activeScreen === 'bookkeeping') await loadBookkeeping();
        } catch (err) {
          alert(err.message);
        }
      });

      document.getElementById('inventory-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('inventory-error');
        const okEl = document.getElementById('inventory-success');
        const btn = document.getElementById('save-btn');
        errEl.textContent = '';
        okEl.textContent = '';
        btn.disabled = true;

        try {
          await api('/api/admin/inventory', {
            method: 'PUT',
            body: JSON.stringify({
              stock: parseInt(document.getElementById('edit-stock').value, 10),
              unit_price: parseInt(document.getElementById('edit-unit-price').value, 10),
              tax_rate: parseInt(document.getElementById('edit-tax-rate').value, 10),
              sold_out: document.getElementById('edit-sold-out').checked,
            }),
          });
          okEl.textContent = '保存しました。予約ページと Stripe Checkout に反映されます。';
          await loadDashboard();
        } catch (err) {
          errEl.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      });

      document.getElementById('shipping-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('shipping-error');
        const okEl = document.getElementById('shipping-success');
        const btn = document.getElementById('save-shipping-btn');
        errEl.textContent = '';
        okEl.textContent = '';
        btn.disabled = true;

        const rates = [...document.querySelectorAll('#shipping-grid input[data-region]')].map((el) => ({
          region: el.dataset.region,
          fee: parseInt(el.value, 10) || 0,
        }));

        try {
          const data = await api('/api/admin/shipping', {
            method: 'PUT',
            body: JSON.stringify({
              rates,
              shipping_tax_rate: parseInt(document.getElementById('edit-shipping-tax-rate').value, 10),
            }),
          });
          renderShippingGrid(data.shipping_regions ?? []);
          okEl.textContent = '送料を保存しました';
        } catch (err) {
          errEl.textContent = err.message;
        } finally {
          btn.disabled = false;
        }
      });

      document.getElementById('toggle-orders-filter-btn').addEventListener('click', () => {
        orderFilter = orderFilter === 'cancelled' ? 'active' : 'cancelled';
        loadOrders().catch((err) => alert(err.message));
      });

      document.getElementById('orders-table-body').addEventListener('click', handleOrdersClick);
      document.getElementById('orders-cards').addEventListener('click', handleOrdersClick);

      document.getElementById('logout-btn').addEventListener('click', () => {
        logoutAdmin();
      });

      document.getElementById('auth-reload-btn').addEventListener('click', () => {
        window.location.reload();
      });

      initBookkeepingYearSelect();
      document.getElementById('bk-year').addEventListener('change', () => {
        loadBookkeeping().catch((err) => alert(err.message));
      });
      document.getElementById('bk-reload-btn').addEventListener('click', () => {
        loadBookkeeping().catch((err) => alert(err.message));
      });
      document.getElementById('bk-save-expenses-btn').addEventListener('click', () => {
        saveBookkeepingExpenses().catch((err) => alert(err.message));
      });
      document.getElementById('bk-csv-btn').addEventListener('click', () => {
        downloadBookkeepingCsv().catch((err) => alert(err.message));
      });
      document.getElementById('bk-pdf-btn').addEventListener('click', printBookkeepingPdf);

      (async function initAdmin() {
        try {
          await checkAdminSession();
          showApp();
          await loadDashboard();
        } catch (err) {
          showAuthError(err.message || '認証の確認に失敗しました');
        }
      })();
