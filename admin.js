import {
  ORDER_STATUSES,
  ORDER_STATUS_CANCELLED,
  ORDER_STATUS_DONE,
  ORDER_STATUS_RESERVED,
  FULFILLMENT_LABELS,
  PAYMENT_CANCELLED,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_REFUNDED,
  PAYMENT_UNPAID,
  SHIPPING_REGIONS,
  calcOrderAmount,
  calcShippingMargin,
  summarizeOrderState,
  stripeLiveDashboardPaymentUrl,
} from '/shared/domain.js';
import { resolveReceptionStatus } from '/shared/reception-status.js';

      const WORKER_URL = window.location.origin;
      const SCREEN_TITLES = {
        products: '商品管理',
        orders: '予約管理',
        stats: '統計',
        bookkeeping: '帳簿・申告',
      };
      let orderFilter = 'pending';
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
        const margin = totals.shipping_margin
          ?? calcShippingMargin(totals.shipping_income, totals.actual_shipping);
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
          <td>
            <input type="number" min="0" step="100" class="bk-actual-shipping" value="${m.actual_shipping}" aria-label="${m.month}月の実配送費（任意税込）" />
          </td>
          <td>
            <input type="text" class="bk-note" value="${esc(m.note)}" aria-label="${m.month}月のメモ" />
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

      async function printBookkeepingPdf() {
        const year = getBookkeepingYear();
        let data;
        try {
          data = await api(`/api/admin/bookkeeping?year=${year}`);
        } catch (err) {
          alert(err.message);
          return;
        }
        const { months, totals } = data;
        const margin = totals.shipping_margin
          ?? calcShippingMargin(totals.shipping_income, totals.actual_shipping);
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
          <p class="meta">${year}年 · 決済済み注文ベース（DB保存値） · 出力日 ${new Date().toLocaleDateString('ja-JP')}</p>
          <div class="summary">
            <div><div class="label">商品売上（税抜）</div><div class="val">${yen(totals.product_subtotal)}</div></div>
            <div><div class="label">消費税（商品分）</div><div class="val">${yen(totals.tax_amount)}</div></div>
            <div><div class="label">消費税（送料分）</div><div class="val">${yen(totals.shipping_tax_amount ?? 0)}</div></div>
            <div><div class="label">送料収入（税込）</div><div class="val">${yen(totals.shipping_income)}</div></div>
            <div><div class="label">売上合計</div><div class="val">${yen(totals.total_amount)}</div></div>
            <div><div class="label">実配送費（任意税込）</div><div class="val">${yen(totals.actual_shipping)}</div></div>
            <div><div class="label">送料差額</div><div class="val">${yen(margin)}</div></div>
          </div>
          <table>
            <thead><tr>
              <th>月</th><th>件数</th><th>商品(税抜)</th><th>消費税(商品)</th><th>消費税(送料)</th><th>送料(税込)</th><th>合計</th><th>実配送費（任意税込）</th><th>メモ</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="note">※ CSV 出力と同一データソース。売上集計の参考資料です。Stripe 手数料は Stripe Dashboard から取得してください。不明点は税務署に相談してください。</p>
          </body></html>`;
        const w = window.open('about:blank', '_blank');
        if (!w) {
          alert('ポップアップを許可してください');
          return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => w.print(), 250);
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

      function populateAuthLoginEmails(emails) {
        const el = document.getElementById('auth-login-email');
        if (!el) return;
        el.textContent = emails?.length
          ? emails.join('、')
          : '登録済みのメールアドレス';
      }

      function showAuthError(msg, loginEmails) {
        document.getElementById('auth-error').style.display = 'block';
        document.getElementById('auth-error-msg').textContent = msg;
        document.getElementById('app').style.display = 'none';
        if (loginEmails) populateAuthLoginEmails(loginEmails);
      }

      async function checkAdminSession() {
        const res = await fetch(`${WORKER_URL}/api/admin/session`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.authenticated) {
          accessLogoutUrl = data.logout_url || null;
          return true;
        }
        if (res.status === 503) {
          populateAuthLoginEmails(data.login_emails);
          throw new Error(data.error || '管理者認証（Cloudflare Access）が設定されていません。');
        }
        populateAuthLoginEmails(data.login_emails);
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
        const amounts = calcOrderAmount(unitPrice, 1, taxRate, 0, 0);
        const taxPerUnit = amounts.taxAmount;
        const inclPerUnit = amounts.subtotal + amounts.taxAmount;
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
          <td class="num">${fmtNum(y.order_count)}件</td>
          <td class="num">${fmtNum(y.total_quantity)}本</td>
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
            <input type="number" min="0" step="100" data-region="${r.id}" value="${feeById[r.id] ?? 0}" aria-label="${esc(r.name)}の送料（税抜・円）" />
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
        if (status === ORDER_STATUS_DONE) return 'done';
        if (status === ORDER_STATUS_CANCELLED) return 'cancelled';
        return 'reserved';
      }

      function paymentPillClass(paymentStatus) {
        if (paymentStatus === PAYMENT_PAID) return 'payment-paid';
        if (paymentStatus === PAYMENT_REFUNDED) return 'payment-refunded';
        if (paymentStatus === PAYMENT_CANCELLED) return 'payment-cancelled';
        if (paymentStatus === PAYMENT_FAILED) return 'payment-failed';
        return 'payment-unpaid';
      }

      function renderOrderStatusCell(o) {
        const status = o.status || ORDER_STATUS_RESERVED;
        const paymentStatus = o.payment_status || PAYMENT_UNPAID;
        const summary = summarizeOrderState(o);
        const fulfillLabel = FULFILLMENT_LABELS[status] || status;
        return `<div class="order-status-cell">
          <div class="order-status-summary ${esc(summary.className)}">${esc(summary.text)}</div>
          <div class="status-badges">
            <span class="status-pill ${paymentPillClass(paymentStatus)}" title="決済（自動）">
              <span class="status-badge-label">決済</span> ${esc(paymentStatus)}
            </span>
            <span class="status-pill ${statusPillClass(status)}" title="予約ステータス（手動）">
              <span class="status-badge-label">予約</span> ${esc(fulfillLabel)}
            </span>
          </div>
        </div>`;
      }

      function renderStripePaymentLink(o) {
        const url = stripeLiveDashboardPaymentUrl({
          paymentIntentId: o.stripe_payment_id,
          sessionId: o.stripe_session_id,
          paymentStatus: o.payment_status || PAYMENT_UNPAID,
        });
        if (!url) return '';
        return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="stripe-dash-link">Stripe 決済</a>`;
      }

      function renderOpsCell(o) {
        const status = o.status || ORDER_STATUS_RESERVED;
        const stripeLink = renderStripePaymentLink(o);
        if (status === ORDER_STATUS_CANCELLED) {
          return `<div class="ops-cell ops-cell-cancelled" data-order-id="${esc(o.order_id)}">
            <div class="ops-actions">
              <button type="button" class="btn btn-primary ops-restore-btn"
                data-order-id="${esc(o.order_id)}"
                data-payment-status="${esc(o.payment_status || PAYMENT_UNPAID)}"
                data-admin-note="${esc(o.admin_note || '')}">再予約</button>
              <button type="button" class="btn btn-danger ops-delete-btn"
                data-order-id="${esc(o.order_id)}">アーカイブ</button>
              ${stripeLink}
            </div>
          </div>`;
        }
        const paymentStatus = o.payment_status || PAYMENT_UNPAID;
        const options = ORDER_STATUSES.map((s) =>
          `<option value="${s}"${s === status ? ' selected' : ''}>${FULFILLMENT_LABELS[s] || s}</option>`
        ).join('');
        const resendEmailBtn = paymentStatus === PAYMENT_PAID
          ? `<button type="button" class="btn ops-resend-email-btn" data-order-id="${esc(o.order_id)}">確認メール再送</button>`
          : '';
        return `<div class="ops-cell" data-order-id="${esc(o.order_id)}" data-payment-status="${esc(paymentStatus)}">
          <p class="ops-status-hint">発送ステータス（手動）</p>
          <select class="ops-status" aria-label="予約ステータス">${options}</select>
          <textarea class="ops-note" placeholder="特記事項（管理者用）">${esc(o.admin_note || '')}</textarea>
          <div class="ops-actions">
            <button type="button" class="btn ops-save ops-save-btn" data-order-id="${esc(o.order_id)}">保存</button>
            ${resendEmailBtn}
            ${stripeLink}
          </div>
        </div>`;
      }

      function renderOrders(orders) {
        const tbody = document.getElementById('orders-table-body');
        const cards = document.getElementById('orders-cards');
        const emptyLabels = {
          pending: '未発送の予約なし',
          shipped: '発送済みの予約なし',
          cancelled: 'キャンセルなし',
        };
        const emptyLabel = emptyLabels[orderFilter] || '予約なし';

        if (!orders.length) {
          tbody.innerHTML = `<tr><td colspan="9" class="empty-msg">${emptyLabel}</td></tr>`;
          cards.innerHTML = `<p class="empty-msg">${emptyLabel}</p>`;
          return;
        }

        tbody.innerHTML = orders.map((o) => {
          const note = o.note ? `<br><span style="color:#888">お客様備考: ${esc(o.note)}</span>` : '';
          return `<tr data-order-id="${esc(o.order_id)}">
            <td class="mono">${esc(o.order_id)}</td>
            <td>${esc(o.last_name)} ${esc(o.first_name)}</td>
            <td>${formatContact(o)}</td>
            <td>${esc(formatAddress(o))}${note}</td>
            <td>${o.quantity}本</td>
            <td class="num">${o.total_amount ? `¥${formatYen(o.total_amount)}` : '—'}</td>
            <td>${renderOrderStatusCell(o)}</td>
            <td style="white-space:nowrap">${esc(o.created_at)}</td>
            <td>${renderOpsCell(o)}</td>
          </tr>`;
        }).join('');

        cards.innerHTML = orders.map((o) => {
          return `
          <article class="order-card" data-order-id="${esc(o.order_id)}">
            <div class="order-card-head">
              <div>
                <div class="order-card-name">${esc(o.last_name)} ${esc(o.first_name)}</div>
                ${renderOrderStatusCell(o)}
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
        const titles = {
          pending: '未発送一覧',
          shipped: '発送済一覧',
          cancelled: 'キャンセル一覧',
        };
        document.getElementById('orders-list-title').textContent = titles[orderFilter] || '予約一覧';
        document.querySelectorAll('.orders-filter-btn').forEach((btn) => {
          const active = btn.dataset.ordersFilter === orderFilter;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      }

      async function loadOrders() {
        const data = await api(`/api/admin/orders?filter=${orderFilter}`);
        updateOrdersFilterUI();
        renderOrders(data.orders ?? []);
      }

      async function saveOrder(orderId, container) {
        const status = container.querySelector('.ops-status').value;
        const adminNote = container.querySelector('.ops-note').value.trim();
        const paymentStatus = container.dataset.paymentStatus || PAYMENT_UNPAID;
        if (status === ORDER_STATUS_CANCELLED && paymentStatus === PAYMENT_PAID) {
          const ok = confirm(
            '決済済みの予約です。Stripe で全額返金したうえでキャンセルします。よろしいですか？',
          );
          if (!ok) return;
        }
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
        if (ps === PAYMENT_PAID || ps === PAYMENT_REFUNDED) {
          alert('決済済み・返金済みの予約は再予約に戻せません。');
          return;
        }
        const msg = 'この予約を再予約（未発送）に戻しますか？在庫が減り、決済リンクは無効です。お客様には新規予約を案内してください。';
        if (!confirm(msg)) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              status: ORDER_STATUS_RESERVED,
              admin_note: btn.dataset.adminNote || '',
            }),
          });
          orderFilter = 'pending';
          await loadOrders();
          await loadDashboard();
        } finally {
          btn.disabled = false;
        }
      }

      async function archiveOrder(btn) {
        const orderId = btn.dataset.orderId;
        if (!confirm('このキャンセル予約をアーカイブしますか？一覧から非表示になりますが、DBと監査ログは保持されます。')) return;
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

      async function resendOrderConfirmationEmail(btn) {
        const orderId = btn.dataset.orderId;
        if (!confirm(`${orderId} の確認メールを再送しますか？`)) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(orderId)}/resend-confirmation-email`, {
            method: 'POST',
          });
          alert('確認メールを送信しました');
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
          archiveOrder(deleteBtn).catch((err) => alert(err.message));
          return;
        }
        const resendBtn = e.target.closest('.ops-resend-email-btn');
        if (resendBtn) {
          resendOrderConfirmationEmail(resendBtn).catch((err) => alert(err.message));
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
        const reception = resolveReceptionStatus({
          sold_out: inv.sold_out,
          stock: inv.stock,
          unit_price: inv.unit_price,
          checkout_enabled: inv.checkout_enabled,
        });
        badge.textContent = reception.label;
        badge.classList.remove('sold-out', 'preparing', 'open', 'error');
        badge.classList.add(reception.badgeClass);

        updatePricingPreview();
        renderShippingGrid(data.shipping_regions ?? []);
        renderStripeMode(inv);
        if (activeScreen === 'orders') loadOrders().catch(() => {});
      }

      function renderStripeMode(inv) {
        const mode = inv.stripe_mode === 'live' ? 'live' : 'test';
        document.getElementById('stripe-mode-test').checked = mode === 'test';
        document.getElementById('stripe-mode-live').checked = mode === 'live';

        const testOk = !!inv.stripe_test_configured;
        const liveOk = !!inv.stripe_live_configured;
        document.getElementById('stripe-test-status').textContent = testOk
          ? 'Worker キー設定済み'
          : 'STRIPE_SECRET_KEY 未設定';
        document.getElementById('stripe-live-status').textContent = liveOk
          ? 'Worker キー設定済み'
          : 'STRIPE_SECRET_KEY_LIVE 未設定';

        document.getElementById('stripe-mode-live').disabled = !liveOk;
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

      document.getElementById('stripe-mode-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('stripe-mode-error');
        const okEl = document.getElementById('stripe-mode-success');
        const btn = document.getElementById('save-stripe-mode-btn');
        errEl.textContent = '';
        okEl.textContent = '';
        btn.disabled = true;

        const selected = document.querySelector('input[name="stripe_mode"]:checked')?.value || 'test';
        if (selected === 'live') {
          const ok = window.confirm(
            '本番決済モードに切り替えます。実際のカード決済が行われます。よろしいですか？',
          );
          if (!ok) {
            btn.disabled = false;
            return;
          }
        }

        try {
          const data = await api('/api/admin/stripe-mode', {
            method: 'PUT',
            body: JSON.stringify({ stripe_mode: selected }),
          });
          okEl.textContent = selected === 'live'
            ? '本番決済モードに切り替えました'
            : 'テスト決済モードに切り替えました';
          renderStripeMode(data.inventory ?? {});
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

      document.querySelectorAll('.orders-filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (orderFilter === btn.dataset.ordersFilter) return;
          orderFilter = btn.dataset.ordersFilter;
          loadOrders().catch((err) => alert(err.message));
        });
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
      document.getElementById('bk-pdf-btn').addEventListener('click', () => {
        printBookkeepingPdf().catch((err) => alert(err.message));
      });

      (async function initAdmin() {
        try {
          await checkAdminSession();
          showApp();
          await loadDashboard();
        } catch (err) {
          showAuthError(err.message || '認証の確認に失敗しました');
        }
      })();
