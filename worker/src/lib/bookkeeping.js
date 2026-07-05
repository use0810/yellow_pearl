import { BOOKKEEPING_ORDER_FILTER, MAX_LEN, sumBookkeepingMonths } from '../../../shared/domain.js';
import { json } from './http.js';

function parseBookkeepingYear(url) {
  const year = parseInt(url.searchParams.get('year') || '', 10);
  if (Number.isNaN(year) || year < 2000 || year > 2100) return null;
  return year;
}

function resolveExpensesYear(body) {
  if (body.year) {
    const year = parseInt(body.year, 10);
    if (!Number.isNaN(year) && year >= 2000 && year <= 2100) return year;
  }
  const years = [...new Set(
    body.expenses
      .map((e) => parseInt(String(e.year_month ?? '').slice(0, 4), 10))
      .filter((y) => !Number.isNaN(y) && y >= 2000 && y <= 2100),
  )];
  if (years.length === 1) return years[0];
  return new Date().getFullYear();
}

async function loadBookkeepingMonths(db, year) {
  const salesRows = await db.prepare(
    `SELECT strftime('%Y-%m', created_at) AS ym,
            COUNT(*) AS order_count,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(unit_price * quantity), 0) AS product_subtotal,
            COALESCE(SUM(tax_amount), 0) AS tax_amount,
            COALESCE(SUM(shipping_tax_amount), 0) AS shipping_tax_amount,
            COALESCE(SUM(shipping_fee), 0) AS shipping_income,
            COALESCE(SUM(total_amount), 0) AS total_amount
     FROM orders
     WHERE ${BOOKKEEPING_ORDER_FILTER}
       AND strftime('%Y', created_at) = ?
     GROUP BY ym
     ORDER BY ym`
  ).bind(String(year)).all();

  const expenseRows = await db.prepare(
    `SELECT year_month, actual_shipping, note
     FROM monthly_expenses
     WHERE year_month LIKE ?`
  ).bind(`${year}-%`).all();

  const salesByMonth = Object.fromEntries((salesRows.results ?? []).map((r) => [r.ym, r]));
  const expenseByMonth = Object.fromEntries(
    (expenseRows.results ?? []).map((r) => [r.year_month, r]),
  );

  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const sales = salesByMonth[ym] ?? {};
    const exp = expenseByMonth[ym] ?? {};
    const shippingIncome = sales.shipping_income ?? 0;
    const actualShipping = exp.actual_shipping ?? 0;
    months.push({
      year_month: ym,
      month: m,
      order_count: sales.order_count ?? 0,
      total_quantity: sales.total_quantity ?? 0,
      product_subtotal: sales.product_subtotal ?? 0,
      tax_amount: sales.tax_amount ?? 0,
      shipping_tax_amount: sales.shipping_tax_amount ?? 0,
      shipping_income: shippingIncome,
      total_amount: sales.total_amount ?? 0,
      actual_shipping: actualShipping,
      shipping_margin: shippingIncome - actualShipping,
      note: exp.note ?? '',
    });
  }
  return months;
}

export async function handleAdminBookkeeping(env, CORS, url) {
  const year = parseBookkeepingYear(url);
  if (!year) return json({ error: '年が不正です' }, 400, CORS);

  const months = await loadBookkeepingMonths(env.DB, year);
  const totals = sumBookkeepingMonths(months);

  return json({
    year,
    months,
    totals: {
      ...totals,
      shipping_margin: totals.shipping_income - totals.actual_shipping,
    },
  }, 200, CORS);
}

export async function handleAdminBookkeepingExpensesUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.expenses)) {
    return json({ error: 'expenses 配列が必要です' }, 400, CORS);
  }
  if (body.expenses.length > 12) {
    return json({ error: '一度に保存できるのは12件までです' }, 400, CORS);
  }

  const stmts = [];
  for (const item of body.expenses) {
    if (!/^\d{4}-\d{2}$/.test(item.year_month ?? '')) {
      return json({ error: '年月の形式が不正です' }, 400, CORS);
    }
    const actualShipping = parseInt(item.actual_shipping, 10);
    if (Number.isNaN(actualShipping) || actualShipping < 0) {
      return json({ error: '実配送費の値が不正です' }, 400, CORS);
    }
    const note = String(item.note ?? '').slice(0, MAX_LEN.admin_note);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO monthly_expenses (year_month, actual_shipping, note, updated_at)
         VALUES (?, ?, ?, datetime('now', '+9 hours'))
         ON CONFLICT(year_month) DO UPDATE SET
           actual_shipping = excluded.actual_shipping,
           note = excluded.note,
           updated_at = excluded.updated_at`
      ).bind(item.year_month, actualShipping, note),
    );
  }

  if (stmts.length) await env.DB.batch(stmts);

  const year = resolveExpensesYear(body);
  const months = await loadBookkeepingMonths(env.DB, year);
  const totals = sumBookkeepingMonths(months);
  return json({
    ok: true,
    months,
    totals: { ...totals, shipping_margin: totals.shipping_income - totals.actual_shipping },
  }, 200, CORS);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildBookkeepingCsv(year, months, totals, orders) {
  const lines = [
    `\uFEFFYellow Pearl 帳簿データ,${year}年`,
    '',
    '【月次サマリー】',
    '年月,件数,本数,商品売上(税抜),消費税(商品),消費税(送料),送料収入(税込),売上合計,実配送費,送料差額,メモ',
    ...months.map((m) => [
      m.year_month,
      m.order_count,
      m.total_quantity,
      m.product_subtotal,
      m.tax_amount,
      m.shipping_tax_amount,
      m.shipping_income,
      m.total_amount,
      m.actual_shipping,
      m.shipping_margin,
      m.note,
    ].map(csvEscape).join(',')),
    '',
    '【年間合計】',
    [
      `${year}年`,
      totals.order_count,
      totals.total_quantity,
      totals.product_subtotal,
      totals.tax_amount,
      totals.shipping_tax_amount,
      totals.shipping_income,
      totals.total_amount,
      totals.actual_shipping,
      totals.shipping_income - totals.actual_shipping,
      '',
    ].map(csvEscape).join(','),
    '',
    '【注文明細（決済済み）】',
    '予約番号,日時,数量,税抜単価,商品売上(税抜),消費税(商品),送料(税込),消費税(送料),合計,都道府県',
    ...orders.map((o) => [
      o.order_id,
      o.created_at,
      o.quantity,
      o.unit_price,
      o.unit_price * o.quantity,
      o.tax_amount,
      o.shipping_fee,
      o.shipping_tax_amount,
      o.total_amount,
      o.prefecture,
    ].map(csvEscape).join(',')),
  ];
  return lines.join('\r\n');
}

export async function handleAdminBookkeepingExport(env, CORS, url) {
  const year = parseBookkeepingYear(url);
  if (!year) return json({ error: '年が不正です' }, 400, CORS);

  const months = await loadBookkeepingMonths(env.DB, year);
  const totals = sumBookkeepingMonths(months);

  const orderRows = await env.DB.prepare(
    `SELECT order_id, created_at, quantity, unit_price, tax_amount,
            shipping_fee, shipping_tax_amount, total_amount, prefecture
     FROM orders
     WHERE ${BOOKKEEPING_ORDER_FILTER}
       AND strftime('%Y', created_at) = ?
     ORDER BY created_at ASC`
  ).bind(String(year)).all();

  const csv = buildBookkeepingCsv(year, months, totals, orderRows.results ?? []);
  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="yellow-pearl-bookkeeping-${year}.csv"`,
    },
  });
}
