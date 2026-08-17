import { PRODUCT_NAME } from '../../../shared/domain.js';

const STRIPE_API = 'https://api.stripe.com/v1';

export function normalizeStripeMode(mode) {
  return mode === 'live' ? 'live' : 'test';
}

export function getStripeSecretKey(env, mode = 'test') {
  return mode === 'live'
    ? (env.STRIPE_SECRET_KEY_LIVE || '')
    : (env.STRIPE_SECRET_KEY || '');
}

export function isStripeEnabledForMode(env, mode = 'test') {
  const key = getStripeSecretKey(env, mode);
  return typeof key === 'string' && key.length > 0;
}

/** @deprecated use isStripeEnabledForMode with explicit mode */
export function isStripeEnabled(env) {
  return isStripeEnabledForMode(env, 'test') || isStripeEnabledForMode(env, 'live');
}

export function stripeModeFromResourceId(id) {
  if (typeof id !== 'string' || !id) return null;
  if (id.includes('_live_')) return 'live';
  if (id.includes('_test_')) return 'test';
  return null;
}

export function resolveStripeMode({
  mode,
  sessionId,
  paymentIntentId,
  defaultMode = 'test',
} = {}) {
  if (mode) return normalizeStripeMode(mode);
  const fromSession = stripeModeFromResourceId(sessionId);
  if (fromSession) return fromSession;
  const fromPayment = stripeModeFromResourceId(paymentIntentId);
  if (fromPayment) return fromPayment;
  return normalizeStripeMode(defaultMode);
}

export async function stripeFetch(env, path, options = {}, mode = 'test') {
  const key = getStripeSecretKey(env, mode);
  if (!key) throw new Error('Stripe が設定されていません');

  const res = await fetch(`${STRIPE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
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

/** テスト/Live 両方の Webhook シークレットで署名検証 */
export async function verifyStripeWebhookAny(rawBody, signatureHeader, env) {
  const secrets = [
    env.STRIPE_WEBHOOK_SECRET,
    env.STRIPE_WEBHOOK_SECRET_LIVE,
  ].filter((s) => typeof s === 'string' && s.length > 0);

  for (const secret of secrets) {
    const event = await verifyStripeWebhook(rawBody, signatureHeader, secret);
    if (event) return event;
  }
  return null;
}

/** 銀行振込（customer_balance）に必須の Customer を作成 */
export async function createStripeCustomer(env, { email, name } = {}, mode = 'test') {
  const params = new URLSearchParams();
  if (email) params.append('email', email);
  if (name) params.append('name', name);
  return stripeFetch(env, '/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, mode);
}

function buildStripeCheckoutParams({
  origin, orderId, customerId, qty, unitPrice, taxRate, taxAmount,
  shippingFeeIncl, shippingExcl, shippingTaxRate, shippingTaxAmount,
}) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${origin}/cart.html?session_id={CHECKOUT_SESSION_ID}`);
  // 中断したセッションを cart 側から通知させ、在庫を 24 時間待たずに戻す
  params.append('cancel_url', `${origin}/cart.html?cancelled=1&abort_session={CHECKOUT_SESSION_ID}`);
  params.append('customer', customerId);
  params.append('client_reference_id', orderId);
  params.append('metadata[order_id]', orderId);
  params.append('metadata[unit_price]', String(unitPrice));
  params.append('metadata[tax_rate]', String(taxRate));
  params.append('metadata[shipping_tax_rate]', String(shippingTaxRate));
  params.append('locale', 'ja');
  // 日本の銀行振込（Dashboard で有効時に Checkout へ表示。Customer 必須）
  params.append('payment_method_options[customer_balance][funding_type]', 'bank_transfer');
  params.append('payment_method_options[customer_balance][bank_transfer][type]', 'jp_bank_transfer');

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

export async function createStripeCheckoutSession(env, opts, mode = 'test') {
  const body = buildStripeCheckoutParams(opts);
  return stripeFetch(env, '/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, mode);
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

export function stripeCustomerId(session) {
  if (!session?.customer) return null;
  return typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null;
}

/**
 * 全銀（zengin）形式の振込先を扱いやすい形に落とす。
 * Stripe は口座の詳細を type と同名のキーに入れるので、そこも見に行く。
 */
function normalizeZenginAddress(address) {
  const z = address?.zengin
    ?? (address?.type ? address[address.type] : null);
  if (!z?.account_number) return null;
  return {
    bank_name: z.bank_name ?? null,
    bank_code: z.bank_code ?? null,
    branch_name: z.branch_name ?? null,
    branch_code: z.branch_code ?? null,
    account_type: z.account_type ?? null,
    account_number: z.account_number ?? null,
    account_holder_name: z.account_holder_name ?? null,
  };
}

/**
 * 銀行振込の専用口座を取得する。Session の PaymentIntent に付く振込手順を読み、
 * 取れない場合は Customer の funding_instructions にフォールバックする。
 */
export async function fetchBankTransferInstructions(env, { sessionId, customerId, mode } = {}) {
  const stripeMode = resolveStripeMode({ mode, sessionId });
  if (!isStripeEnabledForMode(env, stripeMode)) {
    return { ok: false, reason: 'stripe_disabled' };
  }

  let resolvedCustomerId = customerId ?? null;
  let reason = 'no_customer';

  if (sessionId) {
    try {
      const session = await stripeFetch(
        env,
        `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`,
        { method: 'GET' },
        stripeMode,
      );
      resolvedCustomerId = resolvedCustomerId ?? stripeCustomerId(session);
      const instructions = session?.payment_intent?.next_action
        ?.display_bank_transfer_instructions;
      const addresses = instructions?.financial_addresses ?? [];
      const zengin = addresses.map(normalizeZenginAddress).find(Boolean);
      if (zengin) {
        return {
          ok: true,
          info: {
            customer_id: resolvedCustomerId,
            amount_remaining: instructions.amount_remaining ?? null,
            reference: instructions.reference ?? null,
            ...zengin,
          },
        };
      }
      reason = instructions ? 'no_zengin_address' : 'no_transfer_instructions';
    } catch (e) {
      reason = `session_error:${e.message || 'failed'}`;
    }
  }

  if (!resolvedCustomerId) return { ok: false, reason };

  const params = new URLSearchParams({
    currency: 'jpy',
    funding_type: 'bank_transfer',
    'bank_transfer[type]': 'jp_bank_transfer',
  });
  try {
    const funding = await stripeFetch(
      env,
      `/customers/${encodeURIComponent(resolvedCustomerId)}/funding_instructions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      stripeMode,
    );
    const addresses = funding?.bank_transfer?.financial_addresses ?? [];
    const zengin = addresses.map(normalizeZenginAddress).find(Boolean);
    if (!zengin) return { ok: false, reason: 'funding_no_zengin_address' };
    return {
      ok: true,
      info: {
        customer_id: resolvedCustomerId,
        amount_remaining: null,
        reference: null,
        ...zengin,
      },
    };
  } catch (e) {
    return { ok: false, reason: `funding_error:${e.message || 'failed'}` };
  }
}

export async function resolvePaymentIntentId(env, { paymentIntentId, sessionId, mode } = {}) {
  if (paymentIntentId) return paymentIntentId;
  const stripeMode = resolveStripeMode({ mode, sessionId, paymentIntentId });
  if (!sessionId || !isStripeEnabledForMode(env, stripeMode)) return null;
  try {
    const session = await stripeFetch(
      env,
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
      stripeMode,
    );
    return stripePaymentIntentId(session);
  } catch {
    return null;
  }
}

/** 決済済み注文の全額返金（管理画面キャンセル時） */
export async function refundStripePayment(env, { paymentIntentId, sessionId, mode } = {}) {
  const stripeMode = resolveStripeMode({ mode, sessionId, paymentIntentId });
  const pi = await resolvePaymentIntentId(env, { paymentIntentId, sessionId, mode: stripeMode });
  if (!pi) {
    return { error: '返金対象の決済IDがありません', status: 400 };
  }
  if (!isStripeEnabledForMode(env, stripeMode)) {
    return { error: 'Stripe が設定されていません', status: 503 };
  }
  try {
    const refund = await stripeFetch(env, '/refunds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payment_intent: pi }).toString(),
    }, stripeMode);
    return { ok: true, refund_id: refund.id, payment_intent_id: pi };
  } catch (e) {
    return { error: e.message || '返金に失敗しました', status: 502 };
  }
}

/** 未決済 Checkout セッションを失効（キャンセル時など） */
export async function expireStripeCheckoutSession(env, sessionId, { strict = false, mode } = {}) {
  const stripeMode = resolveStripeMode({ mode, sessionId });
  if (!sessionId || !isStripeEnabledForMode(env, stripeMode)) {
    return strict ? { ok: false, error: 'Checkout セッションがありません' } : { ok: true, skipped: true };
  }
  try {
    await stripeFetch(env, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: 'POST',
    }, stripeMode);
    return { ok: true };
  } catch (e) {
    if (strict) {
      return { ok: false, error: e.message || 'Checkout セッションの失効に失敗しました' };
    }
    return { ok: true, ignored: true };
  }
}
