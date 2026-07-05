import {
  PAYMENT_FAILED,
  PAYMENT_UNPAID,
  PRODUCT_ID,
  PREFECTURES,
  calcOrderAmount,
} from '../../../shared/domain.js';
import { json, nowIso } from './http.js';
import { isStripeEnabled } from './stripe.js';
import { ensureRateLimitTable } from './rate-limit.js';

const STALE_STRIPE_ORDER_HOURS = 48;

const INVENTORY_SELECT = `stock, sold_out, unit_price, tax_rate, shipping_tax_rate`;

export async function fetchInventoryRow(db) {
  return db.prepare(
    `SELECT ${INVENTORY_SELECT} FROM inventory WHERE product_id = ?`
  ).bind(PRODUCT_ID).first();
}

export async function decrementStock(db, qty) {
  const result = await db.prepare(
    `UPDATE inventory SET
      stock = stock - ?,
      sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE 0 END
     WHERE product_id = ?
       AND sold_out = 0
       AND stock >= ?`
  ).bind(qty, qty, PRODUCT_ID, qty).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function incrementStock(db, qty) {
  await db.prepare(
    `UPDATE inventory SET
      stock = stock + ?,
      sold_out = CASE WHEN stock + ? > 0 THEN 0 ELSE sold_out END
     WHERE product_id = ?`
  ).bind(qty, qty, PRODUCT_ID).run();
}

/** 未決済 → 失敗 にし、Checkout 時確保した在庫を戻す */
export async function markOrderFailedAndReleaseStock(db, orderId) {
  const order = await db.prepare(
    'SELECT quantity, payment_status FROM orders WHERE order_id = ?'
  ).bind(orderId).first();
  if (!order || order.payment_status !== PAYMENT_UNPAID) return false;

  const result = await db.prepare(
    `UPDATE orders SET payment_status = ? WHERE order_id = ? AND payment_status = ?`
  ).bind(PAYMENT_FAILED, orderId, PAYMENT_UNPAID).run();

  if ((result.meta?.changes ?? 0) > 0) {
    await incrementStock(db, order.quantity);
    return true;
  }
  return false;
}

export async function cleanupStaleOrders(env) {
  await ensureRateLimitTable(env.DB);
  await env.DB.prepare(
    `DELETE FROM rate_limits WHERE expires_at < ?`
  ).bind(nowIso()).run();

  let deleted = 0;

  // Stripe セッション未紐付けの孤立注文（INSERT 後に UPDATE 失敗等）
  const orphanFilter = `payment_status = '${PAYMENT_UNPAID}'
       AND stripe_session_id IS NULL
       AND status = '予約'
       AND created_at < datetime('now', '+9 hours', '-1 hours')`;
  const orphanRows = await env.DB.prepare(
    `SELECT order_id, quantity FROM orders WHERE ${orphanFilter}`
  ).all();
  for (const row of orphanRows.results ?? []) {
    await incrementStock(env.DB, row.quantity);
  }
  deleted += (await env.DB.prepare(`DELETE FROM orders WHERE ${orphanFilter}`).run()).meta?.changes ?? 0;

  const staleFilter = `payment_status IN ('${PAYMENT_UNPAID}', '${PAYMENT_FAILED}')
       AND status = '予約'
       AND created_at < datetime('now', '+9 hours', ?)`;

  const staleRows = await env.DB.prepare(
    `SELECT order_id, quantity, payment_status FROM orders WHERE ${staleFilter}`
  ).bind(`-${STALE_STRIPE_ORDER_HOURS} hours`).all();

  for (const row of staleRows.results ?? []) {
    if (row.payment_status === PAYMENT_UNPAID) {
      await incrementStock(env.DB, row.quantity);
    }
  }

  deleted += (await env.DB.prepare(
    `DELETE FROM orders WHERE ${staleFilter}`
  ).bind(`-${STALE_STRIPE_ORDER_HOURS} hours`).run()).meta?.changes ?? 0;

  return deleted;
}

export async function getShippingMap(db) {
  const rows = await db.prepare('SELECT prefecture, fee FROM shipping_rates').all();
  const map = Object.fromEntries(PREFECTURES.map((p) => [p, 0]));
  for (const r of rows.results ?? []) {
    if (PREFECTURES.includes(r.prefecture)) map[r.prefecture] = r.fee;
  }
  return map;
}

export async function loadPricing(env, prefecture, qty) {
  const inv = await fetchInventoryRow(env.DB);

  if (!inv || inv.sold_out || inv.stock < qty) {
    return { error: '在庫が不足しています', status: 409 };
  }

  const rate = await env.DB.prepare(
    'SELECT fee FROM shipping_rates WHERE prefecture = ?'
  ).bind(prefecture).first();

  const unitPrice = inv.unit_price ?? 0;
  const taxRate = inv.tax_rate ?? 10;
  const shippingTaxRate = inv.shipping_tax_rate ?? 10;
  const shippingFeeIncl = rate?.fee ?? 0;
  const amounts = calcOrderAmount(unitPrice, qty, taxRate, shippingFeeIncl, shippingTaxRate);

  return {
    unitPrice,
    taxRate,
    shippingTaxRate,
    shippingFeeIncl: amounts.shippingFeeIncl,
    shippingExcl: amounts.shippingExcl,
    shippingTaxAmount: amounts.shippingTaxAmount,
    taxAmount: amounts.taxAmount,
    totalAmount: amounts.totalAmount,
  };
}

export async function handleStock(env, CORS) {
  const row = await fetchInventoryRow(env.DB);

  if (!row) return json({ error: 'Not found' }, 404, CORS);

  const shipping = await getShippingMap(env.DB);

  return json({
    stock: row.stock,
    sold_out: row.sold_out === 1,
    unit_price: row.unit_price ?? 0,
    tax_rate: row.tax_rate ?? 10,
    shipping_tax_rate: row.shipping_tax_rate ?? 10,
    shipping,
    checkout_enabled: isStripeEnabled(env),
  }, 200, CORS);
}
