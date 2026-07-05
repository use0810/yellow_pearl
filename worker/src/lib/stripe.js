import { PRODUCT_NAME } from '../../../shared/domain.js';

const STRIPE_API = 'https://api.stripe.com/v1';

export function isStripeEnabled(env) {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 0;
}

export async function stripeFetch(env, path, options = {}) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe API error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyStripeWebhook(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return null;

  let timestamp = null;
  const signatures = [];
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === 't') timestamp = val;
    if (key === 'v1') signatures.push(val);
  }

  if (!timestamp || signatures.length === 0) return null;

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Number.isNaN(age) || age > 300) return null;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function buildStripeCheckoutParams({
  origin, orderId, email, qty, unitPrice, taxRate, taxAmount,
  shippingFeeIncl, shippingExcl, shippingTaxRate, shippingTaxAmount,
}) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${origin}/cart.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${origin}/cart.html?cancelled=1`);
  params.append('customer_email', email);
  params.append('client_reference_id', orderId);
  params.append('metadata[order_id]', orderId);
  params.append('metadata[unit_price]', String(unitPrice));
  params.append('metadata[tax_rate]', String(taxRate));
  params.append('metadata[shipping_tax_rate]', String(shippingTaxRate));
  params.append('locale', 'ja');
  params.append('customer_creation', 'always');

  params.append('line_items[0][quantity]', String(qty));
  params.append('line_items[0][price_data][currency]', 'jpy');
  params.append('line_items[0][price_data][unit_amount]', String(unitPrice));
  params.append('line_items[0][price_data][product_data][name]', PRODUCT_NAME);

  let idx = 1;
  if (taxAmount > 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(taxAmount));
    params.append(`line_items[${idx}][price_data][product_data][name]`, `消費税（商品・${taxRate}%）`);
    idx += 1;
  }
  if (shippingExcl > 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(shippingExcl));
    params.append(`line_items[${idx}][price_data][product_data][name]`, '送料');
    idx += 1;
  }
  if (shippingTaxAmount > 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(shippingTaxAmount));
    params.append(`line_items[${idx}][price_data][product_data][name]`, `消費税（送料・${shippingTaxRate}%）`);
  } else if (shippingFeeIncl > 0 && shippingExcl === 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(shippingFeeIncl));
    params.append(`line_items[${idx}][price_data][product_data][name]`, '送料');
  }

  return params;
}

export async function createStripeCheckoutSession(env, opts) {
  const body = buildStripeCheckoutParams(opts);
  return stripeFetch(env, '/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

export function stripeOrderId(session) {
  return session?.metadata?.order_id || session?.client_reference_id || null;
}

export function isStripeSessionPaid(session) {
  return session?.payment_status === 'paid';
}

export function stripePaymentIntentId(session) {
  if (!session?.payment_intent) return null;
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
}

export async function resolvePaymentIntentId(env, { paymentIntentId, sessionId } = {}) {
  if (paymentIntentId) return paymentIntentId;
  if (!sessionId || !isStripeEnabled(env)) return null;
  try {
    const session = await stripeFetch(
      env,
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
    return stripePaymentIntentId(session);
  } catch {
    return null;
  }
}

/** 決済済み注文の全額返金（管理画面キャンセル時） */
export async function refundStripePayment(env, { paymentIntentId, sessionId } = {}) {
  const pi = await resolvePaymentIntentId(env, { paymentIntentId, sessionId });
  if (!pi) {
    return { error: '返金対象の決済IDがありません', status: 400 };
  }
  if (!isStripeEnabled(env)) {
    return { error: 'Stripe が設定されていません', status: 503 };
  }
  try {
    const refund = await stripeFetch(env, '/refunds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payment_intent: pi }).toString(),
    });
    return { ok: true, refund_id: refund.id, payment_intent_id: pi };
  } catch (e) {
    return { error: e.message || '返金に失敗しました', status: 502 };
  }
}

/** 未決済 Checkout セッションを失効（キャンセル時など） */
export async function expireStripeCheckoutSession(env, sessionId, { strict = false } = {}) {
  if (!sessionId || !isStripeEnabled(env)) {
    return strict ? { ok: false, error: 'Checkout セッションがありません' } : { ok: true, skipped: true };
  }
  try {
    await stripeFetch(env, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: 'POST',
    });
    return { ok: true };
  } catch (e) {
    if (strict) {
      return { ok: false, error: e.message || 'Checkout セッションの失効に失敗しました' };
    }
    return { ok: true, ignored: true };
  }
}
