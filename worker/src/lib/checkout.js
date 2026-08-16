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
  fetchInventoryRow,
  incrementStock,
  insertReservedOrder,
  inventoryStripeMode,
  loadPricing,
  markBankTransferPending,
  markOrderFailedAndReleaseStock,
} from './inventory.js';
import { maybeSendConfirmationEmail } from './email.js';
import {
  createStripeCheckoutSession,
  createStripeCustomer,
  expireStripeCheckoutSession,
  isStripeEnabledForMode,
  isStripeSessionPaid,
  refundStripePayment,
  resolveStripeMode,
  stripeFetch,
  stripeModeFromResourceId,
  stripeOrderId,
  stripePaymentIntentId,
  verifyStripeWebhookAny,
} from './stripe.js';

async function logOrderEvent(db, orderId, eventType, detail = '') {
  await db.prepare(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES (?, ?, ?)`
  ).bind(orderId, eventType, detail).run();
}

/** 決済確定: 在庫は Checkout 開始時に確保済み。payment_status のみ更新 */
export async function confirmOrderPayment(env, orderId, { sessionId = null, paymentId = null } = {}) {
  const order = await env.DB.prepare(
    `SELECT order_id, payment_status, status, quantity FROM orders
     WHERE order_id = ? AND archived_at IS NULL`
  ).bind(orderId).first();

  if (!order) return { error: '予約が見つかりません', status: 404 };
  if (order.payment_status === PAYMENT_PAID) {
    await maybeSendConfirmationEmail(env, orderId);
    return { ok: true, order_id: orderId, already: true };
  }
  if (order.payment_status === PAYMENT_REFUNDED) {
    return { ok: true, order_id: orderId, skipped: true };
  }
  if (order.payment_status === PAYMENT_CANCELLED) {
    if (sessionId || paymentId) {
      const refund = await refundStripePayment(env, {
        paymentIntentId: paymentId,
        sessionId,
        mode: resolveStripeMode({ sessionId, paymentIntentId: paymentId }),
      });
      if (refund.error) {
        return { error: 'キャンセル済み注文への入金返金に失敗しました', status: 503 };
      }
      await env.DB.prepare(
        `UPDATE orders SET payment_status = ?, stripe_payment_id = COALESCE(?, stripe_payment_id)
         WHERE order_id = ? AND payment_status = ?`
      ).bind(PAYMENT_REFUNDED, refund.payment_intent_id ?? null, orderId, PAYMENT_CANCELLED).run();
      return { ok: true, order_id: orderId, refunded: true };
    }
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
      await maybeSendConfirmationEmail(env, orderId);
      return { ok: true, order_id: orderId, already: true };
    }
    return { error: '決済状態を更新できません', status: 409 };
  }

  await maybeSendConfirmationEmail(env, orderId);
  return { ok: true, order_id: orderId };
}

export async function handleCheckout(request, env, CORS) {
  const inv = await fetchInventoryRow(env.DB);
  const stripeMode = inventoryStripeMode(inv);
  if (!isStripeEnabledForMode(env, stripeMode)) {
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
    const customerName = `${last_name} ${first_name}`.trim();
    const customer = await createStripeCustomer(env, {
      email,
      name: customerName || undefined,
    }, stripeMode);
    if (!customer?.id) {
      throw new Error('customer create failed');
    }
    session = await createStripeCheckoutSession(env, {
      origin,
      orderId: order_id,
      customerId: customer.id,
      qty,
      unitPrice,
      taxRate,
      taxAmount,
      shippingFeeIncl,
      shippingExcl,
      shippingTaxRate,
      shippingTaxAmount,
    }, stripeMode);
  } catch {
    await markOrderFailedAndReleaseStock(env.DB, order_id, 'payment_failed_session_create');
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  if (!session?.url || !session?.id) {
    await markOrderFailedAndReleaseStock(env.DB, order_id, 'payment_failed_session_create');
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
    await expireStripeCheckoutSession(env, session.id, { mode: stripeMode });
    await markOrderFailedAndReleaseStock(env.DB, order_id, 'payment_failed_session_link');
    return json({ error: '予約の更新に失敗しました' }, 500, CORS);
  }

  return json({
    order_id,
    session_url: session.url,
    total_amount: totalAmount,
  }, 200, CORS);
}

/**
 * Stripe の決済画面で「戻る」を押した時に cart 側から呼ばれる。
 * セッションを失効させて在庫を即座に戻し、お客様都合の中断として記録する。
 */
export async function handleCheckoutAbort(env, CORS, sessionId) {
  if (!sessionId) return json({ error: 'session_id が必要です' }, 400, CORS);

  const stripeMode = stripeModeFromResourceId(sessionId)
    ?? inventoryStripeMode(await fetchInventoryRow(env.DB));
  if (!isStripeEnabledForMode(env, stripeMode)) {
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  let session;
  try {
    session = await stripeFetch(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    }, stripeMode);
  } catch {
    return json({ error: '決済情報の取得に失敗しました' }, 502, CORS);
  }

  const orderId = stripeOrderId(session);
  if (!orderId) return json({ error: '注文情報が見つかりません' }, 404, CORS);

  // 支払い済み・振込案内済み（complete）は中断ではないので触らない
  if (isStripeSessionPaid(session) || session.status === 'complete') {
    return json({ ok: true, aborted: false, order_id: orderId }, 200, CORS);
  }

  if (session.status === 'open') {
    await expireStripeCheckoutSession(env, sessionId, { mode: stripeMode });
  }
  const aborted = await markOrderFailedAndReleaseStock(
    env.DB, orderId, 'payment_failed_customer_abort',
  );

  return json({ ok: true, aborted, order_id: orderId }, 200, CORS);
}

export async function handleCheckoutReturn(env, CORS, sessionId) {
  if (!sessionId) return json({ error: 'session_id が必要です' }, 400, CORS);

  const stripeMode = stripeModeFromResourceId(sessionId)
    ?? inventoryStripeMode(await fetchInventoryRow(env.DB));
  if (!isStripeEnabledForMode(env, stripeMode)) {
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  let session;
  try {
    session = await stripeFetch(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    }, stripeMode);
  } catch {
    return json({ error: '決済情報の取得に失敗しました' }, 502, CORS);
  }

  const orderId = stripeOrderId(session);
  if (!orderId) return json({ error: '注文情報が見つかりません' }, 404, CORS);

  const orderRow = await env.DB.prepare(
    `SELECT quantity, total_amount FROM orders WHERE order_id = ? AND archived_at IS NULL`
  ).bind(orderId).first();
  const tracking = {
    quantity: orderRow?.quantity ?? null,
    total_amount: orderRow?.total_amount ?? null,
  };

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
      ...tracking,
    }, 200, CORS);
  }

  if (session.status === 'expired') {
    await markOrderFailedAndReleaseStock(env.DB, orderId, 'payment_failed_expired');
    return json({
      ok: false,
      order_id: orderId,
      payment_status: PAYMENT_FAILED,
      session_status: session.status,
      ...tracking,
    }, 200, CORS);
  }

  // 銀行振込など非同期決済: Session 完了後も unpaid のまま振込待ち
  if (session.status === 'complete' || session.status === 'open') {
    if (session.status === 'complete' && session.payment_status !== 'paid') {
      await markBankTransferPending(env.DB, orderId, session);
    }
    return json({
      ok: true,
      pending: true,
      order_id: orderId,
      payment_status: PAYMENT_UNPAID,
      session_status: session.status,
      message: '振込案内に従ってお支払いください。入金確認後に予約が確定し、確認メールをお送りします。',
      ...tracking,
    }, 200, CORS);
  }

  return json({
    ok: false,
    order_id: orderId,
    payment_status: PAYMENT_UNPAID,
    session_status: session.status,
    message: '決済が完了していません。もう一度お試しください。',
    ...tracking,
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

  const event = await verifyStripeWebhookAny(rawBody, signature, env);
  if (!event) return new Response('Invalid signature', { status: 401 });

  const type = event.type;
  const session = event.data?.object;

  if (
    (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded')
    && session
  ) {
    if (type === 'checkout.session.completed' && !isStripeSessionPaid(session)) {
      const orderId = stripeOrderId(session);
      if (orderId) {
        await markBankTransferPending(env.DB, orderId, session);
      }
    } else {
      const result = await processPaidCheckoutSession(env, session);
      if (result.error && !result.already) {
        if (result.status !== 400 && result.status !== 404) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }
  }

  // 振込期限切れ等: 14日の cleanup まで在庫はキープ（即キャンセルしない）
  if (type === 'checkout.session.async_payment_failed' && session) {
    const orderId = stripeOrderId(session);
    if (orderId) {
      await logOrderEvent(
        env.DB,
        orderId,
        'payment_async_failed_noted',
        session.id ? `session=${session.id}` : '',
      );
    }
  }

  if (type === 'checkout.session.expired' && session) {
    const orderId = stripeOrderId(session);
    if (orderId) {
      await markOrderFailedAndReleaseStock(env.DB, orderId, 'payment_failed_expired');
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
