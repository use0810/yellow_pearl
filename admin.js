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
  PREFECTURES,
  PRODUCT_NAME,
  SHIPPING_REGIONS,
  B2_DELIVERY_TIMES,
  bankTransferLines,
  calcOrderAmount,
  calcShippingMargin,
  parseBankTransferInfo,
  summarizeOrderState,
  stripeLiveDashboardPaymentUrl,
} from '/shared/domain.js?v=20260828c';
import { resolveReceptionStatus } from '/shared/reception-status.js';

      const WORKER_URL = window.location.origin;
      const SCREEN_TITLES = {
        products: '商品管理',
        orders: '予約管理',
        stats: '統計',
        bookkeeping: '帳簿・申告',
      };
      let orderFilter = 'pending';
      let orderPage = 1;
      const ORDERS_PAGE_SIZE = 50;
      let orderTotalPages = 1;
      let orderSearchName = '';
      let orderSearchPrefecture = '';
      let orderSearchHasNote = false;
      /** 送り状CSVの対象。ページを移動しても選択は保つ */
      const selectedOrderIds = new Set();
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

      function appendOrdersSearchParams(params) {
        if (orderSearchName) params.set('name', orderSearchName);
        if (orderSearchPrefecture) params.set('prefecture', orderSearchPrefecture);
        if (orderSearchHasNote) params.set('has_note', '1');
        return params;
      }

      async function downloadOrdersCsv() {
        const params = appendOrdersSearchParams(new URLSearchParams({ filter: orderFilter }));
        const res = await fetch(
          `${WORKER_URL}/api/admin/orders/export.csv?${params}`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'CSV の取得に失敗しました');
        }
        const blob = await res.blob();
        const stamp = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `yellow-pearl-orders-${orderFilter}-${stamp}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      const RECONCILE_LABELS = {
        bank_transfer_pending: '銀行振込待ち',
        abandoned_expired: '離脱（Checkout失効）',
        still_open: '決済ページ未完了',
        paid: '入金済（要確認）',
        stripe_error: 'Stripe照会失敗',
        unknown: '判定不能',
      };

      const RECONCILE_BATCH = 25;

      /** Stripe の Checkout Session を照会し、振込待ちと離脱を切り分ける */
      async function reconcileWithStripe() {
        const scope = orderFilter === 'cancelled' ? 'cancelled' : 'unpaid';
        const dry = await api(
          `/api/admin/orders/reconcile?scope=${scope}&limit=${RECONCILE_BATCH}`,
        );

        if (!dry.scanned) {
          alert('照合対象の予約がありません。');
          return;
        }

        const breakdown = Object.entries(dry.counts)
          .map(([key, n]) => `・${RECONCILE_LABELS[key] || key}: ${n}件`)
          .join('\n');
        const head = scope === 'cancelled'
          ? `キャンセル ${dry.scanned}件を Stripe と照合しました。`
          : `振込待ち ${dry.scanned}件を Stripe と照合しました。`;
        const items = dry.items ?? [];
        const countOf = (action) => items.filter((i) => i.action === action).length;
        const toRestore = countOf('would_restore');
        const toFlag = countOf('would_flag');
        const toRelease = countOf('would_release');
        const toLabel = countOf('would_label');

        if (!toRestore && !toFlag && !toRelease && !toLabel) {
          alert(`${head}\n\n${breakdown}\n\n更新が必要な予約はありません。`);
          return;
        }

        const actions = [
          toRestore ? `・${toRestore}件は実際には振込待ちなので予約に戻して在庫を再確保` : '',
          toFlag ? `・${toFlag}件に振込待ちの記録と振込先を保存` : '',
          toRelease ? `・${toRelease}件は失効済みなのでキャンセルして在庫を戻す` : '',
          toLabel ? `・${toLabel}件にキャンセル理由を書き込む` : '',
        ].filter(Boolean).join('\n');
        if (!confirm(`${head}\n\n${breakdown}\n\n以下を実行します。\n${actions}`)) return;

        const applied = await api(
          `/api/admin/orders/reconcile?scope=${scope}&limit=${RECONCILE_BATCH}&apply=1`,
        );
        const rest = applied.scanned >= RECONCILE_BATCH
          ? '\n\nまだ残りがあります。もう一度「Stripe照合」を押してください。'
          : '';
        const bank = applied.bank_info_saved
          ? `\nうち${applied.bank_info_saved}件の振込先を保存しました。`
          : '';
        alert(`${applied.changed}件を更新しました。${bank}${rest}`);
        await loadOrders();
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
          <span class="pricing-preview-note">Stripe には「${esc(PRODUCT_NAME)}」と「消費税（商品・${taxRate}%）」の明細行として送信されます。</span>
        `;
      }

      ['edit-unit-price', 'edit-tax-rate'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', updatePricingPreview);
      });

      function switchScreen(name) {
        activeScreen = name;
        try { sessionStorage.setItem('adminActiveScreen', name); } catch { /* ignore */ }
        document.querySelectorAll('.screen').forEach((el) => {
          el.classList.toggle('active', el.id === `screen-${name}`);
        });
        document.querySelectorAll('.nav-btn').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.screen === name);
        });
        document.getElementById('screen-title').textContent = SCREEN_TITLES[name] || '';
        if (name === 'stats') loadStats().catch((err) => alert(err.message));
        if (name === 'orders') {
          loadOrders().catch((err) => alert(err.message));
          loadShippingLabels().catch((err) => alert(err.message));
        }
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
            <input type="number" min="0" step="1" data-region="${r.id}" value="${feeById[r.id] ?? 0}" aria-label="${esc(r.name)}の送料（税抜・円）" />
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

      function prefectureOptions(selected) {
        return PREFECTURES.map((p) =>
          `<option value="${esc(p)}"${p === selected ? ' selected' : ''}>${esc(p)}</option>`
        ).join('');
      }

      function renderEditableName(o) {
        return `<div class="order-edit-block order-edit-locked">
          <div class="order-edit-row">
            <input type="text" class="oe-last-name" value="${esc(o.last_name || '')}" placeholder="姓" aria-label="姓" readonly tabindex="-1" />
            <input type="text" class="oe-first-name" value="${esc(o.first_name || '')}" placeholder="名" aria-label="名" readonly tabindex="-1" />
          </div>
          <div class="order-edit-row">
            <input type="text" class="oe-last-name-kana" value="${esc(o.last_name_kana || '')}" placeholder="セイ" aria-label="セイ" readonly tabindex="-1" />
            <input type="text" class="oe-first-name-kana" value="${esc(o.first_name_kana || '')}" placeholder="メイ" aria-label="メイ" readonly tabindex="-1" />
          </div>
        </div>`;
      }

      function renderEditableContact(o) {
        return `<div class="order-edit-block order-edit-locked">
          <input type="email" class="oe-email" value="${esc(o.email || '')}" placeholder="メール" aria-label="メール" readonly tabindex="-1" />
          <input type="text" class="oe-phone" value="${esc(o.phone || '')}" placeholder="電話" aria-label="電話" readonly tabindex="-1" />
        </div>`;
      }

      function renderCustomerNote(o) {
        if (!o.note) return '';
        return `<div class="order-edit-note"><strong>お客様備考</strong> ${esc(o.note)}</div>`;
      }

      /** 備考ありの予約は一覧で見落としやすいので行ごと色を変える */
      function noteRowClass(o) {
        const hasNote = String(o.note || '').trim() || String(o.admin_note || '').trim();
        return hasNote ? ' has-note' : '';
      }

      /** 送り状の対象を選べるのは未発送と送り状作成済みのタブだけ */
      function ordersSelectable() {
        return orderFilter === 'pending' || orderFilter === 'labeled';
      }

      /** 送り状を出せるのは入金済・未発送のみ */
      function orderSelectableRow(o) {
        return (o.status || ORDER_STATUS_RESERVED) === ORDER_STATUS_RESERVED
          && (o.payment_status || PAYMENT_UNPAID) === PAYMENT_PAID;
      }

      function renderSelectCell(o, { tag = 'td' } = {}) {
        if (!ordersSelectable()) {
          return tag === 'td' ? '<td class="orders-select-col"></td>' : '';
        }
        const selectable = orderSelectableRow(o);
        const checked = selectedOrderIds.has(o.order_id) ? ' checked' : '';
        const disabled = selectable ? '' : ' disabled';
        const title = selectable ? '' : ' title="入金済の予約のみ選べます"';
        const input = `<input type="checkbox" class="order-select" value="${esc(o.order_id)}"
          aria-label="${esc(o.order_id)} を選択"${checked}${disabled}${title} />`;
        return tag === 'td'
          ? `<td class="orders-select-col">${input}</td>`
          : `<label class="order-card-select">${input}<span>選択</span></label>`;
      }

      /** 送り状を出した日を一覧で分かるようにする */
      function renderShippingLabelNote(o) {
        if (!o.shipping_label_at) return '';
        const stamp = String(o.shipping_label_at).slice(0, 16);
        return `<div class="order-label-note">送り状作成済み ${esc(stamp)}</div>`;
      }

      function renderEditableAddress(o) {
        const note = renderCustomerNote(o);
        return `<div class="order-edit-block order-edit-locked">
          <div class="order-edit-row">
            <input type="text" class="oe-postal" value="${esc(o.postal || '')}" placeholder="郵便番号" aria-label="郵便番号" readonly tabindex="-1" />
            <select class="oe-prefecture" aria-label="都道府県" disabled tabindex="-1">${prefectureOptions(o.prefecture || '')}</select>
          </div>
          <input type="text" class="oe-address1" value="${esc(o.address1 || '')}" placeholder="住所" aria-label="住所" readonly tabindex="-1" />
          <input type="text" class="oe-address2" value="${esc(o.address2 || '')}" placeholder="建物名など（任意）" aria-label="住所2" readonly tabindex="-1" />
          ${note}
        </div>`;
      }

      function setContactEditing(scope, editing) {
        if (!scope) return;
        scope.classList.toggle('is-editing-contact', editing);
        scope.querySelectorAll('.order-edit-block').forEach((block) => {
          block.classList.toggle('order-edit-locked', !editing);
          block.classList.toggle('order-edit-active', editing);
        });
        scope.querySelectorAll('.order-edit-block input').forEach((el) => {
          el.readOnly = !editing;
          el.tabIndex = editing ? 0 : -1;
        });
        scope.querySelectorAll('.order-edit-block select').forEach((el) => {
          el.disabled = !editing;
          el.tabIndex = editing ? 0 : -1;
        });
        const ops = scope.querySelector('.ops-cell');
        if (!ops) return;
        const editBtn = ops.querySelector('.ops-edit-contact-btn');
        const cancelBtn = ops.querySelector('.ops-cancel-contact-btn');
        const hint = ops.querySelector('.ops-contact-hint');
        if (editBtn) editBtn.hidden = editing;
        if (cancelBtn) cancelBtn.hidden = !editing;
        if (hint) {
          hint.textContent = editing
            ? '発送先を編集中。保存で反映（送料・合計は変わりません）'
            : '発送先を変えるときは「発送先を編集」→「保存」';
        }
      }

      function collectContactFields(scope) {
        return {
          last_name: scope.querySelector('.oe-last-name')?.value.trim() ?? '',
          first_name: scope.querySelector('.oe-first-name')?.value.trim() ?? '',
          last_name_kana: scope.querySelector('.oe-last-name-kana')?.value.trim() ?? '',
          first_name_kana: scope.querySelector('.oe-first-name-kana')?.value.trim() ?? '',
          email: scope.querySelector('.oe-email')?.value.trim() ?? '',
          phone: scope.querySelector('.oe-phone')?.value.trim() ?? '',
          postal: scope.querySelector('.oe-postal')?.value.trim() ?? '',
          prefecture: scope.querySelector('.oe-prefecture')?.value ?? '',
          address1: scope.querySelector('.oe-address1')?.value.trim() ?? '',
          address2: scope.querySelector('.oe-address2')?.value.trim() ?? '',
        };
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

      /** 振込先は予約ごとに違う専用口座なので、入金確認の照合用に出す */
      function renderBankTransferInfo(o) {
        if ((o.status || ORDER_STATUS_RESERVED) !== ORDER_STATUS_RESERVED) return '';
        if ((o.payment_status || PAYMENT_UNPAID) !== PAYMENT_UNPAID) return '';
        const info = parseBankTransferInfo(o);
        if (!info) return '';
        const rows = bankTransferLines(info)
          .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(String(value))}</dd>`)
          .join('');
        return `<details class="bank-info">
          <summary>振込先（この予約専用）</summary>
          <dl class="bank-info-dl">${rows}</dl>
        </details>`;
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
          ${renderShippingLabelNote(o)}
          ${renderBankTransferInfo(o)}
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

      function renderDeliveryTimeSelect(o) {
        const current = String(o.delivery_time ?? '');
        const options = B2_DELIVERY_TIMES.map((t) =>
          `<option value="${esc(t.value)}"${t.value === current ? ' selected' : ''}>${esc(t.label)}</option>`
        ).join('');
        return `<p class="ops-status-hint">時間指定（この予約）</p>
          <select class="ops-delivery-time" aria-label="配達時間帯" data-saved-value="${esc(current)}">${options}</select>`;
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
          ${renderDeliveryTimeSelect(o)}
          <textarea class="ops-note" placeholder="特記事項（管理者用）">${esc(o.admin_note || '')}</textarea>
          <p class="ops-contact-hint">発送先を変えるときは「発送先を編集」→「保存」</p>
          <div class="ops-actions">
            <button type="button" class="btn ops-edit-contact-btn" data-order-id="${esc(o.order_id)}">発送先を編集</button>
            <button type="button" class="btn ops-cancel-contact-btn" data-order-id="${esc(o.order_id)}" hidden>やめる</button>
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
          bank_pending: '振込待ちの予約なし',
          labeled: '送り状作成済みの予約なし',
          shipped: '発送済みの予約なし',
          cancelled: 'キャンセルなし',
        };
        let emptyLabel = emptyLabels[orderFilter] || '予約なし';
        if (orderSearchName || orderSearchPrefecture || orderSearchHasNote) {
          emptyLabel = '条件に一致する予約なし';
        }

        if (!orders.length) {
          tbody.innerHTML = `<tr><td colspan="10" class="empty-msg">${emptyLabel}</td></tr>`;
          cards.innerHTML = `<p class="empty-msg">${emptyLabel}</p>`;
          updateOrdersBulkUI();
          return;
        }

        tbody.innerHTML = orders.map((o) => {
          const cancelled = (o.status || ORDER_STATUS_RESERVED) === ORDER_STATUS_CANCELLED;
          const nameCell = cancelled
            ? `${esc(o.last_name)} ${esc(o.first_name)}`
            : renderEditableName(o);
          const contactCell = cancelled ? formatContact(o) : renderEditableContact(o);
          const addressCell = cancelled
            ? `${esc(formatAddress(o))}${renderCustomerNote(o)}`
            : renderEditableAddress(o);
          return `<tr class="order-row${noteRowClass(o)}" data-order-id="${esc(o.order_id)}" data-quantity="${esc(o.quantity ?? 1)}">
            ${renderSelectCell(o)}
            <td class="mono">${esc(o.order_id)}</td>
            <td>${nameCell}</td>
            <td>${contactCell}</td>
            <td>${addressCell}</td>
            <td>${o.quantity}本</td>
            <td class="num">${o.total_amount ? `¥${formatYen(o.total_amount)}` : '—'}</td>
            <td>${renderOrderStatusCell(o)}</td>
            <td style="white-space:nowrap">${esc(o.created_at)}</td>
            <td>${renderOpsCell(o)}</td>
          </tr>`;
        }).join('');

        cards.innerHTML = orders.map((o) => {
          const cancelled = (o.status || ORDER_STATUS_RESERVED) === ORDER_STATUS_CANCELLED;
          if (cancelled) {
            return `
          <article class="order-card${noteRowClass(o)}" data-order-id="${esc(o.order_id)}" data-quantity="${esc(o.quantity ?? 1)}">
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
            </dl>
            ${renderCustomerNote(o)}
            ${renderOpsCell(o)}
          </article>
        `;
          }
          return `
          <article class="order-card${noteRowClass(o)}" data-order-id="${esc(o.order_id)}" data-quantity="${esc(o.quantity ?? 1)}">
            <div class="order-card-head">
              <div>
                ${renderOrderStatusCell(o)}
              </div>
              <div class="order-card-head-right">
                ${renderSelectCell(o, { tag: 'label' })}
                <div class="order-card-id">${esc(o.order_id)}</div>
              </div>
            </div>
            <div class="order-card-edit">
              <p class="order-edit-label">お名前</p>
              ${renderEditableName(o)}
              <p class="order-edit-label">連絡先</p>
              ${renderEditableContact(o)}
              <p class="order-edit-label">住所</p>
              ${renderEditableAddress(o)}
              <dl class="order-card-dl order-card-dl-meta">
                <dt>数量</dt><dd>${o.quantity}本</dd>
                <dt>合計</dt><dd>${o.total_amount ? `¥${formatYen(o.total_amount)}` : '—'}</dd>
                <dt>日時</dt><dd>${esc(o.created_at)}</dd>
              </dl>
            </div>
            ${renderOpsCell(o)}
          </article>
        `;
        }).join('');

        updateOrdersBulkUI();
      }

      function updateOrdersFilterUI() {
        const titles = {
          pending: '未発送一覧',
          bank_pending: '振込待ち一覧',
          labeled: '送り状作成済み一覧',
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

      function updateOrdersPagerUI({ page, total, total_pages: totalPages }) {
        const pager = document.getElementById('orders-pager');
        const info = document.getElementById('orders-pager-info');
        const prev = document.getElementById('orders-page-prev');
        const next = document.getElementById('orders-page-next');
        orderTotalPages = totalPages || 1;
        orderPage = page || 1;
        if (!total) {
          pager.hidden = true;
          return;
        }
        pager.hidden = false;
        const from = (orderPage - 1) * ORDERS_PAGE_SIZE + 1;
        const to = Math.min(orderPage * ORDERS_PAGE_SIZE, total);
        info.textContent = `${from}–${to} / ${total}件（${orderPage}/${orderTotalPages}ページ）`;
        prev.disabled = orderPage <= 1;
        next.disabled = orderPage >= orderTotalPages;
      }

      function initOrdersSearchPrefecture() {
        const sel = document.getElementById('orders-search-prefecture');
        if (!sel || sel.options.length > 1) return;
        for (const p of PREFECTURES) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          sel.appendChild(opt);
        }
      }

      function syncOrdersSearchUI() {
        const nameEl = document.getElementById('orders-search-name');
        const prefEl = document.getElementById('orders-search-prefecture');
        const noteEl = document.getElementById('orders-search-has-note');
        if (nameEl) nameEl.value = orderSearchName;
        if (prefEl) prefEl.value = orderSearchPrefecture;
        if (noteEl) noteEl.checked = orderSearchHasNote;
      }

      /** 表示中のページで選べる予約（テーブルはスマホでも DOM 上にある） */
      function visibleSelectableIds() {
        return [...document.querySelectorAll('#orders-table-body .order-select:not(:disabled)')]
          .map((el) => el.value);
      }

      function syncOrderSelectBoxes(orderId, checked) {
        document.querySelectorAll(`.order-select[value="${CSS.escape(orderId)}"]`).forEach((el) => {
          el.checked = checked;
        });
      }

      function updateOrdersBulkUI() {
        const bar = document.getElementById('orders-bulk');
        if (!bar) return;
        const selectable = ordersSelectable();
        document.getElementById('screen-orders')?.classList.toggle('orders-selectable', selectable);
        bar.hidden = !selectable;
        if (!selectable) return;

        const selected = selectedOrderIds.size;
        const isPending = orderFilter === 'pending';
        document.getElementById('orders-bulk-count').textContent = `${selected}件を選択中`;

        const labelBtn = document.getElementById('orders-label-btn');
        const revertBtn = document.getElementById('orders-label-revert-btn');
        const dateField = document.getElementById('orders-bulk-date-field');
        labelBtn.hidden = !isPending;
        dateField.hidden = !isPending;
        revertBtn.hidden = isPending;
        labelBtn.disabled = selected === 0;
        revertBtn.disabled = selected === 0;

        const visible = visibleSelectableIds();
        const selectAll = document.getElementById('orders-select-all');
        selectAll.disabled = visible.length === 0;
        selectAll.checked = visible.length > 0 && visible.every((id) => selectedOrderIds.has(id));
      }

      function clearOrderSelection() {
        selectedOrderIds.clear();
        document.querySelectorAll('.order-select').forEach((el) => { el.checked = false; });
        updateOrdersBulkUI();
      }

      function handleOrdersSelectChange(e) {
        const timeSel = e.target.closest('.ops-delivery-time');
        if (timeSel) {
          const container = timeSel.closest('.ops-cell');
          if (!container) return;
          const previous = timeSel.dataset.savedValue ?? [...timeSel.options].find((o) => o.defaultSelected)?.value ?? '';
          timeSel.disabled = true;
          const status = container.querySelector('.ops-status')?.value;
          const adminNote = container.querySelector('.ops-note')?.value.trim() ?? '';
          api(`/api/admin/orders/${encodeURIComponent(container.dataset.orderId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              status,
              admin_note: adminNote,
              delivery_time: timeSel.value,
            }),
          })
            .then(() => { timeSel.dataset.savedValue = timeSel.value; })
            .catch((err) => {
              timeSel.value = previous;
              alert(err.message);
            })
            .finally(() => { timeSel.disabled = false; });
          return;
        }
        const box = e.target.closest('.order-select');
        if (!box) return;
        if (box.checked) selectedOrderIds.add(box.value);
        else selectedOrderIds.delete(box.value);
        syncOrderSelectBoxes(box.value, box.checked);
        updateOrdersBulkUI();
      }

      function downloadCsvText(csv, filename) {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      function initShipDateInput() {
        const el = document.getElementById('orders-ship-date');
        if (!el || el.value) return;
        const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        el.value = jst.toISOString().slice(0, 10);
      }

      function selectedSlipCount() {
        let total = 0;
        for (const id of selectedOrderIds) {
          const row = document.querySelector(`#orders-table-body tr[data-order-id="${CSS.escape(id)}"]`);
          const n = parseInt(row?.dataset.quantity, 10);
          total += Number.isFinite(n) && n > 0 ? n : 1;
        }
        return total;
      }

      async function createShippingLabels() {
        const ids = [...selectedOrderIds];
        if (!ids.length) return;
        const shipDate = document.getElementById('orders-ship-date').value;
        if (!shipDate) {
          alert('出荷予定日を入れてください。');
          return;
        }
        const slips = selectedSlipCount();
        const ok = confirm(
          `${ids.length}件の予約から送り状CSV（ヤマトB2クラウド）を作成します。\n`
          + `出荷予定日: ${shipDate}\n`
          + `伝票: ${slips}枚（1本につき1枚）\n`
          + '時間指定は各予約の操作欄で選んだ値が入ります。\n\n'
          + '作成した予約は「送り状作成済み」タブへ移ります。',
        );
        if (!ok) return;

        const data = await api('/api/admin/shipping-labels', {
          method: 'POST',
          body: JSON.stringify({ order_ids: ids, ship_date: shipDate }),
        });
        downloadCsvText(data.csv, data.batch?.filename || 'yellow-pearl-b2.csv');
        selectedOrderIds.clear();
        await loadOrders();
        await loadShippingLabels();

        const msgs = [
          `予約${data.order_count ?? ids.length}件・伝票${data.slip_count ?? data.batch?.order_count ?? 0}枚の送り状CSVを作成しました。`,
        ];
        if (data.skipped?.length) {
          msgs.push('', `対象外だった予約（入金済・未発送・送り状未作成のみ）: ${data.skipped.join(', ')}`);
        }
        if (data.warnings?.length) {
          msgs.push('', '取り込む前に確認してください:', ...data.warnings);
        }
        alert(msgs.join('\n'));
      }

      async function revertShippingLabels() {
        const ids = [...selectedOrderIds];
        if (!ids.length) return;
        const ok = confirm(`${ids.length}件を未発送に戻します。よろしいですか？`);
        if (!ok) return;

        const data = await api('/api/admin/shipping-labels/revert', {
          method: 'POST',
          body: JSON.stringify({ order_ids: ids }),
        });
        selectedOrderIds.clear();
        await loadOrders();
        alert(`${data.reverted ?? 0}件を未発送に戻しました。`);
      }

      function renderShippingLabelBatches(batches) {
        const tbody = document.getElementById('labels-table-body');
        if (!tbody) return;
        if (!batches.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">送り状CSVはまだありません</td></tr>';
          return;
        }
        tbody.innerHTML = batches.map((b) => `<tr data-batch-id="${esc(b.id)}">
          <td style="white-space:nowrap">${esc(b.created_at)}</td>
          <td style="white-space:nowrap">${esc(b.ship_date)}</td>
          <td class="num">${b.order_count}枚</td>
          <td>${esc(b.created_by || '—')}</td>
          <td>
            <div class="ops-actions">
              <button type="button" class="btn label-download-btn" data-batch-id="${esc(b.id)}">CSV</button>
              <button type="button" class="btn btn-danger label-delete-btn" data-batch-id="${esc(b.id)}">削除</button>
            </div>
          </td>
        </tr>`).join('');
      }

      async function loadShippingLabels() {
        const data = await api('/api/admin/shipping-labels');
        renderShippingLabelBatches(data.batches ?? []);
      }

      async function downloadShippingLabelBatch(batchId) {
        const res = await fetch(
          `${WORKER_URL}/api/admin/shipping-labels/${encodeURIComponent(batchId)}/download.csv`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'CSV の取得に失敗しました');
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `yellow-pearl-b2-${batchId}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      }

      async function deleteShippingLabelBatch(batchId) {
        const ok = confirm(
          'この送り状CSVの履歴を削除します。\n'
          + '予約は「送り状作成済み」のままです（戻すときは一覧で選んで「未発送に戻す」）。',
        );
        if (!ok) return;
        await api(`/api/admin/shipping-labels/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
        await loadShippingLabels();
      }

      function handleLabelsClick(e) {
        const downloadBtn = e.target.closest('.label-download-btn');
        if (downloadBtn) {
          downloadShippingLabelBatch(downloadBtn.dataset.batchId).catch((err) => alert(err.message));
          return;
        }
        const deleteBtn = e.target.closest('.label-delete-btn');
        if (deleteBtn) {
          deleteShippingLabelBatch(deleteBtn.dataset.batchId).catch((err) => alert(err.message));
        }
      }

      async function loadOrders({ preserveScroll = true } = {}) {
        const scrollY = preserveScroll ? window.scrollY : 0;
        const params = appendOrdersSearchParams(new URLSearchParams({
          filter: orderFilter,
          page: String(orderPage),
          limit: String(ORDERS_PAGE_SIZE),
        }));
        const data = await api(`/api/admin/orders?${params}`);
        if (data.page && data.page !== orderPage) {
          orderPage = data.page;
        }
        updateOrdersFilterUI();
        updateOrdersPagerUI(data);
        syncOrdersSearchUI();
        renderOrders(data.orders ?? []);
        if (preserveScroll) {
          requestAnimationFrame(() => {
            window.scrollTo(0, scrollY);
          });
        }
      }

      function applyOrdersSearch() {
        orderSearchName = document.getElementById('orders-search-name').value.trim();
        orderSearchPrefecture = document.getElementById('orders-search-prefecture').value;
        orderSearchHasNote = !!document.getElementById('orders-search-has-note')?.checked;
        orderPage = 1;
        selectedOrderIds.clear();
        return loadOrders();
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
        const scope = container.closest('tr, .order-card');
        const editingContact = scope?.classList.contains('is-editing-contact');
        const contact = editingContact && scope?.querySelector('.oe-last-name')
          ? collectContactFields(scope)
          : null;
        const body = { status, admin_note: adminNote };
        const deliveryTime = container.querySelector('.ops-delivery-time')?.value;
        if (deliveryTime !== undefined) body.delivery_time = deliveryTime;
        if (contact) Object.assign(body, contact);
        await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
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
          orderPage = 1;
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
        const editContactBtn = e.target.closest('.ops-edit-contact-btn');
        if (editContactBtn) {
          const scope = editContactBtn.closest('tr, .order-card');
          setContactEditing(scope, true);
          scope?.querySelector('.oe-last-name')?.focus();
          return;
        }
        const cancelContactBtn = e.target.closest('.ops-cancel-contact-btn');
        if (cancelContactBtn) {
          loadOrders().catch((err) => alert(err.message));
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
          orderPage = 1;
          selectedOrderIds.clear();
          loadOrders().catch((err) => alert(err.message));
        });
      });

      document.getElementById('orders-search-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        applyOrdersSearch().catch((err) => alert(err.message));
      });

      document.getElementById('orders-search-btn')?.addEventListener('click', () => {
        applyOrdersSearch().catch((err) => alert(err.message));
      });

      document.getElementById('orders-search-name')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        applyOrdersSearch().catch((err) => alert(err.message));
      });

      document.getElementById('orders-csv-btn')?.addEventListener('click', () => {
        downloadOrdersCsv().catch((err) => alert(err.message));
      });
      document.getElementById('orders-reconcile-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '照合中...';
        reconcileWithStripe()
          .catch((err) => alert(err.message))
          .finally(() => {
            btn.disabled = false;
            btn.textContent = 'Stripe照合';
          });
      });
      document.getElementById('orders-search-has-note')?.addEventListener('change', () => {
        applyOrdersSearch().catch((err) => alert(err.message));
      });
      document.getElementById('orders-search-clear')?.addEventListener('click', () => {
        orderSearchName = '';
        orderSearchPrefecture = '';
        orderSearchHasNote = false;
        orderPage = 1;
        selectedOrderIds.clear();
        syncOrdersSearchUI();
        loadOrders().catch((err) => alert(err.message));
      });

      document.getElementById('orders-page-prev').addEventListener('click', () => {
        if (orderPage <= 1) return;
        orderPage -= 1;
        loadOrders().catch((err) => alert(err.message));
      });

      document.getElementById('orders-page-next').addEventListener('click', () => {
        if (orderPage >= orderTotalPages) return;
        orderPage += 1;
        loadOrders().catch((err) => alert(err.message));
      });

      document.getElementById('orders-table-body').addEventListener('click', handleOrdersClick);
      document.getElementById('orders-cards').addEventListener('click', handleOrdersClick);
      document.getElementById('orders-table-body').addEventListener('change', handleOrdersSelectChange);
      document.getElementById('orders-cards').addEventListener('change', handleOrdersSelectChange);

      document.getElementById('orders-select-all')?.addEventListener('change', (e) => {
        const { checked } = e.currentTarget;
        visibleSelectableIds().forEach((id) => {
          if (checked) selectedOrderIds.add(id);
          else selectedOrderIds.delete(id);
          syncOrderSelectBoxes(id, checked);
        });
        updateOrdersBulkUI();
      });

      document.getElementById('orders-select-clear-btn')?.addEventListener('click', () => {
        clearOrderSelection();
      });

      document.getElementById('orders-label-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        createShippingLabels()
          .catch((err) => alert(err.message))
          .finally(() => updateOrdersBulkUI());
      });

      document.getElementById('orders-label-revert-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        revertShippingLabels()
          .catch((err) => alert(err.message))
          .finally(() => updateOrdersBulkUI());
      });

      document.getElementById('labels-table-body')?.addEventListener('click', handleLabelsClick);
      document.getElementById('labels-reload-btn')?.addEventListener('click', () => {
        loadShippingLabels().catch((err) => alert(err.message));
      });

      document.getElementById('logout-btn').addEventListener('click', () => {
        logoutAdmin();
      });

      document.getElementById('auth-reload-btn').addEventListener('click', () => {
        window.location.reload();
      });

      initBookkeepingYearSelect();
      initOrdersSearchPrefecture();
      initShipDateInput();
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
          let savedScreen = 'products';
          try { savedScreen = sessionStorage.getItem('adminActiveScreen') || 'products'; } catch { /* ignore */ }
          if (savedScreen !== 'products' && SCREEN_TITLES[savedScreen]) {
            switchScreen(savedScreen);
          }
        } catch (err) {
          showAuthError(err.message || '認証の確認に失敗しました');
        }
      })();
