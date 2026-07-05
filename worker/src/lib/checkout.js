import {
  MAX_LEN,
  MAX_ORDER_QTY,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_UNPAID,
  PREFECTURES,
} from '../../../shared/domain.js';
import { json, generateOrderId } from './http.js';
import {
  decrementStock,
  incrementStock,
  loadPricing,
  markOrderFailedAndReleaseStock,
} from './inventory.js';
import {
  createStripeCheckoutSession,
  isStripeEnabled,
  isStripeSessionPaid,
  stripeFetch,
  stripeOrderId,
  stripePaymentIntentId,
  verifyStripeWebhook,
} from './stripe.js';

function parseReserveBody(body) {
  if (!body) return { error: 'Invalid JSON' };

  const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
  const lastNameKana = body.last_name_kana || '';
  const firstNameKana = body.first_name_kana || '';

  if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
    return { error: '必須項目が不足しています' };
  }
  if (!PREFECTURES.includes(prefecture)) {
    return { error: '都道府県が不正です' };
  }
  if (
    last_name.length > MAX_LEN.name || first_name.length > MAX_LEN.name ||
    lastNameKana.length > MAX_LEN.name || firstNameKana.length > MAX_LEN.name ||
    email.length > MAX_LEN.email || phone.length > MAX_LEN.phone ||
    postal.length > MAX_LEN.postal || address1.length > MAX_LEN.address ||
    (body.address2 || '').length > MAX_LEN.address ||
    (body.note || '').length > MAX_LEN.note
  ) {
    return { error: '入力が長すぎます' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'メールアドレスの形式が正しくありません' };
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1 || qty > MAX_ORDER_QTY) {
    return { error: '数量が不正です' };
  }

  return {
    data: {
      last_name,
      first_name,
      email,
      phone,
      postal,
      prefecture,
      address1,
      address2: body.address2 || '',
      note: body.note || '',
      last_name_kana: lastNameKana,
      first_name_kana: firstNameKana,
      qty,
    },
  };
}

/** 決済確定: 在庫は Checkout 開始時に確保済み。payment_status のみ更新 */
export async function confirmOrderPayment(env, orderId, { sessionId = null, paymentId = null } = {}) {
  const order = await env.DB.prepare(
    `SELECT order_id, payment_status, status FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  if (!order) return { error: '予約が見つかりません', status: 404 };
  if (order.payment_status === PAYMENT_PAID) {
    return { ok: true, order_id: orderId, already: true };
  }
  if (order.status === 'キャンセル') {
    return { error: 'キャンセル済みの予約です', status: 409 };
  }

  const updateResult = await env.DB.prepare(
    `UPDATE orders SET
      payment_status = ?,
      stripe_session_id = COALESCE(?, stripe_session_id),
      stripe_payment_id = COALESCE(?, stripe_payment_id)
     WHERE order_id = ? AND payment_status = ?`
  ).bind(PAYMENT_PAID, sessionId, paymentId, orderId, PAYMENT_UNPAID).run();

  const changes = updateResult.meta?.changes ?? 0;
  if (changes === 0) {
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
  const parsed = parseReserveBody(body);
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

  if (!(await decrementStock(env.DB, qty))) {
    return json({ error: '在庫が不足しています' }, 409, CORS);
  }

  const order_id = generateOrderId();
  const origin = new URL(request.url).origin;

  try {
    await env.DB.prepare(
      `INSERT INTO orders (
        order_id, last_name, first_name, last_name_kana, first_name_kana,
        email, phone, postal, prefecture, address1, address2, note,
        quantity, unit_price, shipping_fee, shipping_tax_rate, shipping_tax_amount,
        tax_amount, total_amount,
        payment_status, stripe_session_id, status, admin_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '予約', '')`
    ).bind(
      order_id,
      last_name, first_name, last_name_kana, first_name_kana,
      email, phone, postal, prefecture, address1, address2, note,
      qty, unitPrice, shippingFeeIncl, shippingTaxRate, shippingTaxAmount,
      taxAmount, totalAmount,
      PAYMENT_UNPAID,
    ).run();
  } catch {
    await incrementStock(env.DB, qty);
    return json({ error: '予約の保存に失敗しました' }, 500, CORS);
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
    await env.DB.prepare('DELETE FROM orders WHERE order_id = ?').bind(order_id).run();
    await incrementStock(env.DB, qty);
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  if (!session?.url || !session?.id) {
    await env.DB.prepare('DELETE FROM orders WHERE order_id = ?').bind(order_id).run();
    await incrementStock(env.DB, qty);
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  await env.DB.prepare(
    `UPDATE orders SET stripe_session_id = ? WHERE order_id = ?`
  ).bind(session.id, order_id).run();

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
    if (result.error) {
      const retry = result.status === 404 || result.status >= 500;
      if (retry) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
