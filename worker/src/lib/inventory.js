import {
  ORDER_STATUS_CANCELLED,
  ORDER_STATUS_RESERVED,
  PAYMENT_FAILED,
  PAYMENT_UNPAID,
  PRODUCT_ID,
  PREFECTURES,
  calcOrderAmount,
} from '../../../shared/domain.js';
import { json, nowIso } from './http.js';
import { isStripeEnabledForMode, normalizeStripeMode, stripeFetch, stripeModeFromResourceId } from './stripe.js';
import { ensureRateLimitTable } from './rate-limit.js';

/** カード離脱などの安全網（Webhook が主経路） */
const STALE_STRIPE_ORDER_HOURS = 48;
/** 銀行振込待ちの絶対上限 */
const BANK_TRANSFER_PENDING_MAX_HOURS = 14 * 24;

const INVENTORY_SELECT = `stock, sold_out, unit_price, tax_rate, shipping_tax_rate, stripe_mode`;

const ORDER_INSERT_COLUMNS = `order_id, last_name, first_name, last_name_kana, first_name_kana,
  email, phone, postal, prefecture, address1, address2, note,
  quantity, unit_price, shipping_fee, shipping_tax_rate, shipping_tax_amount,
  tax_amount, total_amount,
  payment_status, stripe_session_id, status, admin_note`;

/** 在庫確保と INSERT を D1 batch（単一トランザクション）で実行 */
export async function insertReservedOrder(db, order) {
  const {
    order_id, last_name, first_name, last_name_kana, first_name_kana,
    email, phone, postal, prefecture, address1, address2, note,
    qty, unitPrice, shippingFeeIncl, shippingTaxRate, shippingTaxAmount,
    taxAmount, totalAmount,
  } = order;

  const insertStmt = db.prepare(
    `INSERT INTO orders (${ORDER_INSERT_COLUMNS})
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
     FROM inventory
     WHERE product_id = ? AND sold_out = 0 AND stock >= ?`
  ).bind(
    order_id,
    last_name, first_name, last_name_kana, first_name_kana,
    email, phone, postal, prefecture, address1, address2, note,
    qty, unitPrice, shippingFeeIncl, shippingTaxRate, shippingTaxAmount,
    taxAmount, totalAmount,
    PAYMENT_UNPAID,
    ORDER_STATUS_RESERVED,
    '',
    PRODUCT_ID,
    qty,
  );

  const decrementStmt = db.prepare(
    `UPDATE inventory SET
      stock = stock - ?,
      sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE 0 END
     WHERE product_id = ?
       AND sold_out = 0
       AND stock >= ?`
  ).bind(qty, qty, PRODUCT_ID, qty);

  const results = await db.batch([insertStmt, decrementStmt]);
  const inserted = (results[0].meta?.changes ?? 0) > 0;
  const decremented = (results[1].meta?.changes ?? 0) > 0;
  return inserted && decremented;
}

export async function fetchInventoryRow(db) {
  return db.prepare(
    `SELECT ${INVENTORY_SELECT} FROM inventory WHERE product_id = ?`
  ).bind(PRODUCT_ID).first();
}

export function inventoryStripeMode(row) {
  return normalizeStripeMode(row?.stripe_mode);
}

/** /api/stock と管理ダッシュボードで共有する inventory 公開フィールド */
export function inventoryPublicFields(row, env) {
  const stripeMode = inventoryStripeMode(row);
  return {
    stock: row?.stock ?? 0,
    sold_out: row?.sold_out === 1,
    unit_price: row?.unit_price ?? 0,
    tax_rate: row?.tax_rate ?? 10,
    shipping_tax_rate: row?.shipping_tax_rate ?? 10,
    stripe_mode: stripeMode,
    stripe_test_configured: isStripeEnabledForMode(env, 'test'),
    stripe_live_configured: isStripeEnabledForMode(env, 'live'),
    checkout_enabled: isStripeEnabledForMode(env, stripeMode),
  };
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

async function logOrderEvent(db, orderId, eventType, detail = '') {
  await db.prepare(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES (?, ?, ?)`
  ).bind(orderId, eventType, detail).run();
}

async function hasOrderEvent(db, orderId, eventType) {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM order_events WHERE order_id = ? AND event_type = ? LIMIT 1`
  ).bind(orderId, eventType).first();
  return !!row?.ok;
}

/** 銀行振込待ちを明示（冪等） */
export async function markBankTransferPending(db, orderId, session = null) {
  if (!orderId) return false;
  if (await hasOrderEvent(db, orderId, 'bank_transfer_pending')) return false;
  const methods = Array.isArray(session?.payment_method_types)
    ? session.payment_method_types.join(',')
    : '';
  const detail = [
    session?.id ? `session=${session.id}` : '',
    methods ? `methods=${methods}` : '',
  ].filter(Boolean).join(';');
  await logOrderEvent(db, orderId, 'bank_transfer_pending', detail);
  return true;
}

/**
 * 未決済 → 失敗 にし、Checkout 時確保した在庫を戻す。
 * @param {string} [reason] order_events の event_type（例: payment_failed_expired）
 */
export async function markOrderFailedAndReleaseStock(db, orderId, reason = 'payment_failed') {
  const order = await db.prepare(
    'SELECT quantity, payment_status FROM orders WHERE order_id = ? AND archived_at IS NULL'
  ).bind(orderId).first();
  if (!order || order.payment_status !== PAYMENT_UNPAID) return false;

  const result = await db.prepare(
    `UPDATE orders SET payment_status = ?, status = ? WHERE order_id = ? AND payment_status = ? AND archived_at IS NULL`
  ).bind(PAYMENT_FAILED, ORDER_STATUS_CANCELLED, orderId, PAYMENT_UNPAID).run();

  if ((result.meta?.changes ?? 0) > 0) {
    await incrementStock(db, order.quantity);
    if (reason) {
      await logOrderEvent(db, orderId, reason, '');
    }
    return true;
  }
  return false;
}

export async function cleanupStaleOrders(env) {
  await ensureRateLimitTable(env.DB);
  await env.DB.prepare(
    `DELETE FROM rate_limits WHERE expires_at < ?`
  ).bind(nowIso()).run();

  let cleaned = 0;

  // Stripe セッション未紐付けの孤立注文（INSERT 後に UPDATE 失敗等）
  const orphanFilter = `archived_at IS NULL
       AND payment_status = '${PAYMENT_UNPAID}'
       AND stripe_session_id IS NULL
       AND status = '${ORDER_STATUS_RESERVED}'
       AND created_at < datetime('now', '+9 hours', '-1 hours')`;
  const orphanRows = await env.DB.prepare(
    `SELECT order_id FROM orders WHERE ${orphanFilter}`
  ).all();
  for (const row of orphanRows.results ?? []) {
    if (await markOrderFailedAndReleaseStock(env.DB, row.order_id, 'payment_failed_orphan')) {
      cleaned += 1;
    }
  }

  // 失敗のまま予約ステータスが残っているもの
  const failedReserved = await env.DB.prepare(
    `SELECT order_id FROM orders
     WHERE archived_at IS NULL
       AND payment_status = '${PAYMENT_FAILED}'
       AND status = '${ORDER_STATUS_RESERVED}'
       AND created_at < datetime('now', '+9 hours', ?)`
  ).bind(`-${STALE_STRIPE_ORDER_HOURS} hours`).all();
  for (const row of failedReserved.results ?? []) {
    cleaned += (await env.DB.prepare(
      `UPDATE orders SET status = ? WHERE order_id = ? AND status = ?`
    ).bind(ORDER_STATUS_CANCELLED, row.order_id, ORDER_STATUS_RESERVED).run()).meta?.changes ?? 0;
  }

  // 未決済＋セッションあり: 振込待ちはスキップ、expired / 14日超のみ解放
  const unpaidWithSession = await env.DB.prepare(
    `SELECT order_id, stripe_session_id, created_at FROM orders
     WHERE archived_at IS NULL
       AND payment_status = '${PAYMENT_UNPAID}'
       AND stripe_session_id IS NOT NULL
       AND status = '${ORDER_STATUS_RESERVED}'
       AND created_at < datetime('now', '+9 hours', ?)`
  ).bind(`-${STALE_STRIPE_ORDER_HOURS} hours`).all();

  for (const row of unpaidWithSession.results ?? []) {
    const pastAbsoluteLimit = await env.DB.prepare(
      `SELECT 1 AS ok FROM orders
       WHERE order_id = ?
         AND created_at < datetime('now', '+9 hours', ?)`
    ).bind(row.order_id, `-${BANK_TRANSFER_PENDING_MAX_HOURS} hours`).first();

    if (pastAbsoluteLimit) {
      if (await markOrderFailedAndReleaseStock(env.DB, row.order_id, 'payment_failed_cleanup_limit')) {
        cleaned += 1;
      }
      continue;
    }

    const stripeMode = stripeModeFromResourceId(row.stripe_session_id)
      ?? inventoryStripeMode(await fetchInventoryRow(env.DB));
    if (!isStripeEnabledForMode(env, stripeMode)) {
      continue;
    }

    let session = null;
    try {
      session = await stripeFetch(
        env,
        `/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`,
        { method: 'GET' },
        stripeMode,
      );
    } catch {
      // 取得失敗時は絶対上限まで待つ（上で処理済み以外はスキップ）
      continue;
    }

    // 銀行振込待ち: Session 完了・未払い → 在庫は確保したまま（フラグも補完）
    if (session?.status === 'complete' && session?.payment_status !== 'paid') {
      await markBankTransferPending(env.DB, row.order_id, session);
      continue;
    }

    if (session?.status === 'expired' || session?.status === 'open') {
      // open が長く残るケースは絶対上限で落とす。expired は即解放。
      if (session.status === 'expired') {
        if (await markOrderFailedAndReleaseStock(env.DB, row.order_id, 'payment_failed_expired')) {
          cleaned += 1;
        }
      }
    }
  }

  return cleaned;
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
  const shippingFeeExcl = rate?.fee ?? 0;
  const amounts = calcOrderAmount(unitPrice, qty, taxRate, shippingFeeExcl, shippingTaxRate);

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
    ...inventoryPublicFields(row, env),
    shipping,
  }, 200, CORS);
}
