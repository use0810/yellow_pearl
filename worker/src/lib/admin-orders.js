import {
  BOOKKEEPING_ORDER_FILTER,
  MAX_LEN,
  ORDER_STATUSES,
  orderHoldsStock,
  getShippingRegionsFromMap,
} from '../../../shared/domain.js';
import { json } from './http.js';
import {
  decrementStock,
  fetchInventoryRow,
  getShippingMap,
  incrementStock,
} from './inventory.js';

const ORDER_SELECT = `order_id, last_name, first_name, last_name_kana, first_name_kana,
  email, phone, postal, prefecture, address1, address2, note,
  quantity, unit_price, shipping_fee, tax_amount, total_amount,
  status, payment_status, admin_note, created_at`;

export async function handleAdminDashboard(env, CORS) {
  const inv = await fetchInventoryRow(env.DB);

  const sold = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS sold FROM orders WHERE ${BOOKKEEPING_ORDER_FILTER}`
  ).first() ?? { sold: 0 };
  const orderCount = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM orders WHERE ${BOOKKEEPING_ORDER_FILTER}`
  ).first() ?? { cnt: 0 };

  const shippingMap = await getShippingMap(env.DB);

  return json({
    inventory: {
      stock: inv?.stock ?? 0,
      sold_out: inv?.sold_out === 1,
      unit_price: inv?.unit_price ?? 0,
      tax_rate: inv?.tax_rate ?? 10,
      shipping_tax_rate: inv?.shipping_tax_rate ?? 10,
    },
    shipping_regions: getShippingRegionsFromMap(shippingMap),
    sold: sold?.sold ?? 0,
    order_count: orderCount?.cnt ?? 0,
  }, 200, CORS);
}

export async function handleAdminOrders(env, CORS, url) {
  const filter = url.searchParams.get('filter') === 'cancelled' ? 'cancelled' : 'active';
  const query = filter === 'cancelled'
    ? `SELECT ${ORDER_SELECT} FROM orders WHERE status = 'キャンセル' ORDER BY id DESC LIMIT 100`
    : `SELECT ${ORDER_SELECT} FROM orders WHERE status != 'キャンセル' ORDER BY id DESC LIMIT 100`;

  const rows = await env.DB.prepare(query).all();
  return json({ orders: rows.results ?? [], filter }, 200, CORS);
}

export async function handleAdminOrderUpdate(request, env, CORS, orderId) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const { status, admin_note: adminNote = '' } = body;
  if (!ORDER_STATUSES.includes(status)) {
    return json({ error: 'ステータスが不正です' }, 400, CORS);
  }
  if (adminNote.length > MAX_LEN.admin_note) {
    return json({ error: '特記事項が長すぎます' }, 400, CORS);
  }

  const order = await env.DB.prepare(
    'SELECT quantity, status, payment_status FROM orders WHERE order_id = ?'
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);

  const oldStatus = order.status || '予約';
  const qty = order.quantity;
  const holdsStock = orderHoldsStock(order.payment_status);

  if (oldStatus !== 'キャンセル' && status === 'キャンセル') {
    if (holdsStock) {
      await incrementStock(env.DB, qty);
    }
    await env.DB.prepare(
      `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
    ).bind(status, adminNote, orderId).run();
  } else if (oldStatus === 'キャンセル' && status !== 'キャンセル') {
    if (holdsStock) {
      if (!(await decrementStock(env.DB, qty))) {
        return json({ error: '在庫が不足しているため、キャンセルから戻せません' }, 409, CORS);
      }
      try {
        await env.DB.prepare(
          `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
        ).bind(status, adminNote, orderId).run();
      } catch {
        await incrementStock(env.DB, qty);
        return json({ error: '予約の更新に失敗しました' }, 500, CORS);
      }
    } else {
      await env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
      ).bind(status, adminNote, orderId).run();
    }
  } else {
    await env.DB.prepare(
      `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
    ).bind(status, adminNote, orderId).run();
  }

  const updated = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  return json({ order: updated }, 200, CORS);
}

export async function handleAdminOrderDelete(env, CORS, orderId) {
  const order = await env.DB.prepare(
    'SELECT status FROM orders WHERE order_id = ?'
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);
  if (order.status !== 'キャンセル') {
    return json({ error: 'キャンセル済みの予約のみ削除できます' }, 400, CORS);
  }

  await env.DB.prepare('DELETE FROM orders WHERE order_id = ?').bind(orderId).run();
  return json({ ok: true }, 200, CORS);
}

export async function handleAdminStats(env, CORS) {
  const rows = await env.DB.prepare(
    `SELECT strftime('%Y', created_at) AS year,
            COUNT(*) AS order_count,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(total_amount), 0) AS amount
     FROM orders
     WHERE ${BOOKKEEPING_ORDER_FILTER}
       AND CAST(strftime('%Y', created_at) AS INTEGER)
           < CAST(strftime('%Y', datetime('now', '+9 hours')) AS INTEGER)
     GROUP BY year
     ORDER BY year ASC`
  ).all();

  const yearly = (rows.results ?? []).map((r) => ({
    year: parseInt(r.year, 10),
    order_count: r.order_count,
    total_quantity: r.total_quantity,
    amount: r.amount,
  }));

  return json({ yearly }, 200, CORS);
}
