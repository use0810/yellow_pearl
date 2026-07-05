import {
  ORDER_STATUS_CANCELLED,
  ORDER_STATUS_RESERVED,
  PAYMENT_CANCELLED,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_REFUNDED,
  PAYMENT_UNPAID,
  validateReserveFields,
} from '../../../shared/domain.js';
import { json, generateOrderId } from './http.js';
import {
  decrementStock,
  incrementStock,
  insertReservedOrder,
  loadPricing,
  markOrderFailedAndReleaseStock,
} from './inventory.js';
import {
  createStripeCheckoutSession,
  expireStripeCheckoutSession,
  isStripeEnabled,
  isStripeSessionPaid,
  stripeFetch,
  stripeOrderId,
  stripePaymentIntentId,
  verifyStripeWebhook,
} from './stripe.js';

/** 決済確定: 在庫は Checkout 開始時に確保済み。payment_status のみ更新 */
export async function confirmOrderPayment(env, orderId, { sessionId = null, paymentId = null } = {}) {
  const order = await env.DB.prepare(
    `SELECT order_id, payment_status, status, quantity FROM orders
     WHERE order_id = ? AND archived_at IS NULL`
  ).bind(orderId).first();

  if (!order) return { error: '予約が見つかりません', status: 404 };
  if (order.payment_status === PAYMENT_PAID) {
    return { ok: true, order_id: orderId, already: true };
  }
  if (order.payment_status === PAYMENT_REFUNDED) {
    return { ok: true, order_id: orderId, skipped: true };
  }
  if (order.payment_status === PAYMENT_CANCELLED) {
    return { ok: true, order_id: orderId, skipped: true };
  }
  if (order.status === ORDER_STATUS_CANCELLED && order.payment_status === PAYMENT_UNPAID) {
    return { error: 'キャンセル済みの予約です', status: 409 };
  }
  if (order.status === ORDER_STATUS_CANCELLED && order.payment_status !== PAYMENT_FAILED) {
    return { ok: true, order_id: orderId, skipped: true };
  }

  const recoveringFromFailed = order.payment_status === PAYMENT_FAILED;

  if (recoveringFromFailed) {
    if (!(await decrementStock(env.DB, order.quantity))) {
      return { error: '在庫が不足しています（決済は完了）', status: 503 };
    }
  }

  const updateResult = await env.DB.prepare(
    `UPDATE orders SET
      payment_status = ?,
      status = CASE WHEN status = ? THEN ? ELSE status END,
      stripe_session_id = COALESCE(?, stripe_session_id),
      stripe_payment_id = COALESCE(?, stripe_payment_id)
     WHERE order_id = ?
       AND payment_status IN (?, ?)
       AND archived_at IS NULL
       AND (status != ? OR payment_status = ?)`
  ).bind(
    PAYMENT_PAID,
    ORDER_STATUS_CANCELLED,
    ORDER_STATUS_RESERVED,
    sessionId,
    paymentId,
    orderId,
    PAYMENT_UNPAID,
    PAYMENT_FAILED,
    ORDER_STATUS_CANCELLED,
    PAYMENT_FAILED,
  ).run();

  const changes = updateResult.meta?.changes ?? 0;
  if (changes === 0) {
    if (recoveringFromFailed) {
      await incrementStock(env.DB, order.quantity);
    }
    const current = await env.DB.prepare(
      `SELECT payment_status FROM orders WHERE order_id = ?`
    ).bind(orderId).first();
    if (current?.payment_status === PAYMENT_PAID) {
      return { ok: true, order_id: orderId, already: true };
    }
    return { error: '決済状態を更新できません', status: 409 };
  }

  return { ok: true, order_id: orderId };
}

export async function handleCheckout(request, env, CORS) {
  if (!isStripeEnabled(env)) {
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  const body = await request.json().catch(() => null);
  const parsed = validateReserveFields(body);
  if (parsed.error) return json({ error: parsed.error }, 400, CORS);

  const {
    last_name, first_name, email, phone, postal, prefecture, address1,
    address2, note, last_name_kana, first_name_kana, qty,
  } = parsed.data;

  const pricing = await loadPricing(env, prefecture, qty);
  if (pricing.error) return json({ error: pricing.error }, pricing.status, CORS);

  const {
    unitPrice, taxRate, shippingTaxRate, shippingFeeIncl, shippingExcl,
    shippingTaxAmount, taxAmount, totalAmount,
  } = pricing;
  if (unitPrice <= 0) {
    return json({ error: '商品単価が設定されていません。管理画面で価格を設定してください。' }, 503, CORS);
  }

  const order_id = generateOrderId();
  const origin = new URL(request.url).origin;

  if (!(await insertReservedOrder(env.DB, {
    order_id,
    last_name, first_name, last_name_kana, first_name_kana,
    email, phone, postal, prefecture, address1, address2, note,
    qty, unitPrice, shippingFeeIncl, shippingTaxRate, shippingTaxAmount,
    taxAmount, totalAmount,
  }))) {
    return json({ error: '在庫が不足しています' }, 409, CORS);
  }

  let session;
  try {
    session = await createStripeCheckoutSession(env, {
      origin,
      orderId: order_id,
      email,
      qty,
      unitPrice,
      taxRate,
      taxAmount,
      shippingFeeIncl,
      shippingExcl,
      shippingTaxRate,
      shippingTaxAmount,
    });
  } catch {
    await markOrderFailedAndReleaseStock(env.DB, order_id);
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  if (!session?.url || !session?.id) {
    await markOrderFailedAndReleaseStock(env.DB, order_id);
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  try {
    const linkResult = await env.DB.prepare(
      `UPDATE orders SET stripe_session_id = ? WHERE order_id = ? AND archived_at IS NULL`
    ).bind(session.id, order_id).run();
    if ((linkResult.meta?.changes ?? 0) === 0) {
      throw new Error('session link failed');
    }
  } catch {
    await expireStripeCheckoutSession(env, session.id);
    await markOrderFailedAndReleaseStock(env.DB, order_id);
    return json({ error: '予約の更新に失敗しました' }, 500, CORS);
  }

  return json({
    order_id,
    session_url: session.url,
    total_amount: totalAmount,
  }, 200, CORS);
}

export async function handleCheckoutReturn(env, CORS, sessionId) {
  if (!sessionId) return json({ error: 'session_id が必要です' }, 400, CORS);
  if (!isStripeEnabled(env)) return json({ error: '決済は現在利用できません' }, 503, CORS);

  let session;
  try {
    session = await stripeFetch(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
  } catch {
    return json({ error: '決済情報の取得に失敗しました' }, 502, CORS);
  }

  const orderId = stripeOrderId(session);
  if (!orderId) return json({ error: '注文情報が見つかりません' }, 404, CORS);

  if (isStripeSessionPaid(session)) {
    const result = await confirmOrderPayment(env, orderId, {
      sessionId: session.id,
      paymentId: stripePaymentIntentId(session),
    });
    if (result.error) return json({ error: result.error }, result.status, CORS);
    return json({
      ok: true,
      order_id: orderId,
      payment_status: PAYMENT_PAID,
      session_status: session.status,
    }, 200, CORS);
  }

  if (session.status === 'expired') {
    await markOrderFailedAndReleaseStock(env.DB, orderId);
    return json({
      ok: false,
      order_id: orderId,
      payment_status: PAYMENT_FAILED,
      session_status: session.status,
    }, 200, CORS);
  }

  return json({
    ok: false,
    order_id: orderId,
    payment_status: PAYMENT_UNPAID,
    session_status: session.status,
    message: '決済が完了していません。もう一度お試しください。',
  }, 200, CORS);
}

async function processPaidCheckoutSession(env, session) {
  const orderId = stripeOrderId(session);
  if (!orderId || !isStripeSessionPaid(session)) {
    return { ok: true, skipped: true };
  }
  return confirmOrderPayment(env, orderId, {
    sessionId: session.id,
    paymentId: stripePaymentIntentId(session),
  });
}

export async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  const event = await verifyStripeWebhook(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!event) return new Response('Invalid signature', { status: 401 });

  const type = event.type;
  const session = event.data?.object;

  if (
    (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded')
    && session
  ) {
    const result = await processPaidCheckoutSession(env, session);
    if (result.error && !result.already) {
      const retry = result.status !== 400;
      if (retry) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  }

  if (type === 'checkout.session.async_payment_failed' && session) {
    const orderId = stripeOrderId(session);
    if (orderId) {
      await markOrderFailedAndReleaseStock(env.DB, orderId);
    }
  }

  if (type === 'checkout.session.expired' && session) {
    const orderId = stripeOrderId(session);
    if (orderId) {
      await markOrderFailedAndReleaseStock(env.DB, orderId);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
