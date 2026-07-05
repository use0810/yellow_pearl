import {
  BOOKKEEPING_ORDER_FILTER,
  MAX_LEN,
  ORDER_STATUSES,
  ORDER_STATUS_CANCELLED,
  ORDER_STATUS_DONE,
  ORDER_STATUS_RESERVED,
  ORDER_NOT_ARCHIVED,
  PAYMENT_CANCELLED,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_REFUNDED,
  PAYMENT_UNPAID,
  orderHoldsStock,
  getShippingRegionsFromMap,
} from '../../../shared/domain.js';
import { json } from './http.js';
import {
  decrementStock,
  fetchInventoryRow,
  getShippingMap,
  incrementStock,
  inventoryPublicFields,
} from './inventory.js';
import { expireStripeCheckoutSession, refundStripePayment, resolveStripeMode } from './stripe.js';
import { maybeSendCancellationEmail, resendConfirmationEmail } from './email.js';

const ORDER_SELECT = `order_id, last_name, first_name, last_name_kana, first_name_kana,
  email, phone, postal, prefecture, address1, address2, note,
  quantity, unit_price, shipping_fee, tax_amount, total_amount,
  status, payment_status, admin_note, stripe_session_id, stripe_payment_id, created_at`;

async function logOrderEvent(db, orderId, eventType, detail = '') {
  await db.prepare(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES (?, ?, ?)`
  ).bind(orderId, eventType, detail).run();
}

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
    inventory: inventoryPublicFields(inv, env),
    shipping_regions: getShippingRegionsFromMap(shippingMap),
    sold: sold?.sold ?? 0,
    order_count: orderCount?.cnt ?? 0,
  }, 200, CORS);
}

export async function handleAdminOrders(env, CORS, url) {
  const filter = url.searchParams.get('filter') === 'cancelled' ? 'cancelled' : 'active';
  const query = filter === 'cancelled'
    ? `SELECT ${ORDER_SELECT} FROM orders WHERE status = '${ORDER_STATUS_CANCELLED}' AND ${ORDER_NOT_ARCHIVED} ORDER BY id DESC LIMIT 100`
    : `SELECT ${ORDER_SELECT} FROM orders WHERE status != '${ORDER_STATUS_CANCELLED}' AND ${ORDER_NOT_ARCHIVED} ORDER BY id DESC LIMIT 100`;

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
    `SELECT quantity, status, payment_status, stripe_session_id, stripe_payment_id
     FROM orders WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);

  const oldStatus = order.status || ORDER_STATUS_RESERVED;
  const qty = order.quantity;

  if (oldStatus !== ORDER_STATUS_CANCELLED && status === ORDER_STATUS_CANCELLED) {
    if (order.payment_status === PAYMENT_PAID) {
      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ?
         WHERE order_id = ? AND payment_status = ? AND status != ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(ORDER_STATUS_CANCELLED, adminNote, orderId, PAYMENT_PAID, ORDER_STATUS_CANCELLED).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（決済状態が変更されています）' }, 409, CORS);
      }

      const stripeMode = resolveStripeMode({
        sessionId: order.stripe_session_id,
        paymentIntentId: order.stripe_payment_id,
      });
      const refund = await refundStripePayment(env, {
        paymentIntentId: order.stripe_payment_id,
        sessionId: order.stripe_session_id,
        mode: stripeMode,
      });
      if (refund.error) {
        await env.DB.prepare(
          `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
        ).bind(oldStatus, '', orderId).run();
        return json({ error: refund.error }, refund.status, CORS);
      }

      await incrementStock(env.DB, qty);

      const payUpdate = await env.DB.prepare(
        `UPDATE orders SET payment_status = ?, stripe_payment_id = COALESCE(?, stripe_payment_id)
         WHERE order_id = ? AND payment_status = ?`
      ).bind(PAYMENT_REFUNDED, refund.payment_intent_id ?? null, orderId, PAYMENT_PAID).run();

      if ((payUpdate.meta?.changes ?? 0) === 0) {
        await logOrderEvent(env.DB, orderId, 'refund_db_sync_failed', refund.refund_id ?? '');
        return json({ error: '返金は完了しましたが記録に失敗しました。管理者に連絡してください。' }, 500, CORS);
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', `refunded:${PAYMENT_PAID}`);
      await maybeSendCancellationEmail(env, orderId, { refunded: true });
    } else if (order.payment_status === PAYMENT_UNPAID) {
      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, admin_note = ?
         WHERE order_id = ? AND payment_status = ? AND status != ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(
        ORDER_STATUS_CANCELLED, PAYMENT_CANCELLED, adminNote, orderId, PAYMENT_UNPAID, ORDER_STATUS_CANCELLED,
      ).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（決済が完了した可能性があります）' }, 409, CORS);
      }

      await incrementStock(env.DB, qty);

      if (order.stripe_session_id) {
        await expireStripeCheckoutSession(env, order.stripe_session_id, {
          mode: resolveStripeMode({ sessionId: order.stripe_session_id }),
        });
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', `admin:${PAYMENT_CANCELLED}`);
      await maybeSendCancellationEmail(env, orderId, { refunded: false });
    } else {
      const oldPaymentStatus = order.payment_status;
      const paymentStatus = oldPaymentStatus === PAYMENT_FAILED
        ? PAYMENT_CANCELLED
        : oldPaymentStatus;

      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, admin_note = ?
         WHERE order_id = ? AND status = ? AND payment_status = ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(
        ORDER_STATUS_CANCELLED, paymentStatus, adminNote,
        orderId, oldStatus, oldPaymentStatus,
      ).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（状態が変更されています）' }, 409, CORS);
      }

      if (orderHoldsStock(oldPaymentStatus)) {
        await incrementStock(env.DB, qty);
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', oldPaymentStatus);
      await maybeSendCancellationEmail(env, orderId, {
        refunded: oldPaymentStatus === PAYMENT_REFUNDED,
      });
    }
  } else if (oldStatus === ORDER_STATUS_CANCELLED && status !== ORDER_STATUS_CANCELLED) {
    if (
      order.payment_status === PAYMENT_PAID
      || order.payment_status === PAYMENT_REFUNDED
    ) {
      return json({ error: '決済済み・返金済みの予約は再予約に戻せません' }, 400, CORS);
    }
    if (!(await decrementStock(env.DB, qty))) {
      return json({ error: '在庫が不足しているため、キャンセルから戻せません' }, 409, CORS);
    }
    try {
      const restored = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, stripe_session_id = NULL, admin_note = ?
         WHERE order_id = ? AND status = ? AND ${ORDER_NOT_ARCHIVED}
           AND payment_status NOT IN (?, ?)`
      ).bind(
        status, PAYMENT_UNPAID, adminNote, orderId,
        ORDER_STATUS_CANCELLED, PAYMENT_PAID, PAYMENT_REFUNDED,
      ).run();
      if ((restored.meta?.changes ?? 0) === 0) {
        await incrementStock(env.DB, qty);
        return json({ error: '再予約に戻せません（状態が変更されています）' }, 409, CORS);
      }
      await logOrderEvent(env.DB, orderId, 'restored', status);
    } catch {
      await incrementStock(env.DB, qty);
      return json({ error: '予約の更新に失敗しました' }, 500, CORS);
    }
  } else {
    if (
      status === ORDER_STATUS_DONE
      && order.payment_status !== PAYMENT_PAID
    ) {
      return json({ error: '未決済の予約は発送済みにできません' }, 400, CORS);
    }
    await env.DB.prepare(
      `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
    ).bind(status, adminNote, orderId).run();
  }

  const updated = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  return json({ order: updated }, 200, CORS);
}

export async function handleAdminResendConfirmationEmail(env, CORS, orderId) {
  const result = await resendConfirmationEmail(env, orderId);
  if (result.error) {
    return json({ error: result.error }, result.status ?? 500, CORS);
  }
  return json({ ok: true }, 200, CORS);
}

export async function handleAdminOrderDelete(env, CORS, orderId, adminEmail = '') {
  const order = await env.DB.prepare(
    `SELECT status FROM orders WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);
  if (order.status !== ORDER_STATUS_CANCELLED) {
    return json({ error: 'キャンセル済みの予約のみアーカイブできます' }, 400, CORS);
  }

  const archiveResult = await env.DB.prepare(
    `UPDATE orders SET archived_at = datetime('now', '+9 hours'), archived_by = ?
     WHERE order_id = ? AND status = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(adminEmail, orderId, ORDER_STATUS_CANCELLED).run();

  if ((archiveResult.meta?.changes ?? 0) === 0) {
    return json({ error: 'アーカイブできませんでした' }, 409, CORS);
  }

  await logOrderEvent(env.DB, orderId, 'archived', adminEmail);
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
