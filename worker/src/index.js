const DEFAULT_ORIGINS = 'https://yellow-pearl.com,https://www.yellow-pearl.com';
const PRODUCT_ID = 'yellow-pearl';
const PRODUCT_NAME = 'Yellow Pearl（イエローパール）';
const STALE_STRIPE_ORDER_HOURS = 48;

const MAX_LEN = { name: 50, email: 100, phone: 20, postal: 10, address: 200, note: 500, admin_note: 500 };
const ORDER_STATUSES = ['予約', '済み', 'キャンセル'];

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const SHIPPING_REGIONS = [
  { id: 'hokkaido', name: '北海道', prefectures: ['北海道'] },
  { id: 'okinawa', name: '沖縄', prefectures: ['沖縄県'] },
  { id: 'tohoku', name: '東北地方', prefectures: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'] },
  { id: 'kanto', name: '関東地方', prefectures: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'] },
  { id: 'chubu', name: '中部地方', prefectures: ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'] },
  { id: 'kinki', name: '近畿地方', prefectures: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'] },
  { id: 'chugoku', name: '中国地方', prefectures: ['鳥取県', '島根県', '岡山県', '広島県', '山口県'] },
  { id: 'shikoku', name: '四国地方', prefectures: ['徳島県', '香川県', '愛媛県', '高知県'] },
  { id: 'kyushu', name: '九州地方', prefectures: ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県'] },
];

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS;
  if (raw === '*') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function buildCors(env, request, { credentials = false } = {}) {
  const allowed = parseAllowedOrigins(env);
  const origin = request?.headers?.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (credentials) headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...headers,
    },
  });
}

function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `YP-${ts}-${rand}`;
}

function accessConfigured(env) {
  return typeof env.ACCESS_TEAM_DOMAIN === 'string' && env.ACCESS_TEAM_DOMAIN.trim().length > 0;
}

function parseAdminAllowedEmails(env) {
  const raw = env.ADMIN_ALLOWED_EMAILS?.trim();
  if (!raw) return null;
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmailAllowed(email, allowed) {
  if (!allowed?.length) return true;
  if (!email || typeof email !== 'string') return false;
  return allowed.includes(email.trim().toLowerCase());
}

function accessLogoutUrl(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!team) return null;
  const returnTo = `${new URL(request.url).origin}/admin.html`;
  return `https://${team}/cdn-cgi/access/logout?return_to=${encodeURIComponent(returnTo)}`;
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const ACCESS_CERTS_TTL_MS = 3600_000;

function parseJwtPart(part) {
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (part.length % 4)) % 4));
  return JSON.parse(json);
}

let accessCertsCache = { keys: null, fetchedAt: 0 };

async function getAccessCerts(teamDomain) {
  if (accessCertsCache.keys && Date.now() - accessCertsCache.fetchedAt < ACCESS_CERTS_TTL_MS) {
    return accessCertsCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Access certs fetch failed');
  const data = await res.json();
  accessCertsCache = { keys: data.keys ?? [], fetchedAt: Date.now() };
  return accessCertsCache.keys;
}

async function verifyAccessJwtSignature(token, teamDomain) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const header = parseJwtPart(parts[0]);
  const keys = await getAccessCerts(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(parts[2]),
    data,
  );
}

/** Cloudflare Access JWT（署名 + exp + aud） */
async function verifyAccessJwt(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!jwt || !teamDomain) return null;

  try {
    const payload = parseJwtPart(jwt.split('.')[1]);
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    if (env.ACCESS_AUD && payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.ACCESS_AUD)) return null;
    }
    if (!(await verifyAccessJwtSignature(jwt, teamDomain))) return null;

    const email = typeof payload.email === 'string' ? payload.email : null;
    if (!isAdminEmailAllowed(email, parseAdminAllowedEmails(env))) return null;

    return { ok: true, via: 'access', email };
  } catch {
    return null;
  }
}

async function verifyAdminAuth(request, env) {
  if (!accessConfigured(env)) {
    return { error: '管理者認証（Cloudflare Access）が設定されていません', status: 503 };
  }
  const access = await verifyAccessJwt(request, env);
  if (access) return access;
  return { error: '認証が必要です', status: 401 };
}

async function handleAdminSessionCheck(request, env, CORS) {
  const auth = await verifyAdminAuth(request, env);
  if (auth.error) {
    return json({ authenticated: false, error: auth.error }, auth.status, CORS);
  }
  return json({
    authenticated: true,
    via: auth.via,
    email: auth.email ?? null,
    logout_url: accessLogoutUrl(request, env),
  }, 200, CORS);
}

function nowIso() {
  return new Date().toISOString();
}

function calcOrderAmount(unitPrice, qty, taxRate, shippingFee) {
  const subtotal = unitPrice * qty;
  const taxAmount = Math.floor(subtotal * taxRate / 100);
  const totalAmount = subtotal + taxAmount + shippingFee;
  return { subtotal, taxAmount, totalAmount };
}

/** 在庫が足りるときだけ減算（1クエリで原子的に判定） */
async function decrementStock(db, qty) {
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

async function incrementStock(db, qty) {
  await db.prepare(
    `UPDATE inventory SET
      stock = stock + ?,
      sold_out = CASE WHEN stock + ? > 0 THEN 0 ELSE sold_out END
     WHERE product_id = ?`
  ).bind(qty, qty, PRODUCT_ID).run();
}

let rateLimitTableReady = false;

async function ensureRateLimitTable(db) {
  if (rateLimitTableReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL
    )`
  ).run();
  rateLimitTableReady = true;
}

/** 上限超えなら true（Stripe Webhook は除外すること） */
async function isRateLimited(env, bucket, ip, limit, windowMinutes) {
  await ensureRateLimitTable(env.DB);
  const windowMs = windowMinutes * 60 * 1000;
  const windowId = Math.floor(Date.now() / windowMs);
  const key = `${bucket}:${ip}:${windowId}`;
  const expiresAt = new Date((windowId + 1) * windowMs).toISOString();

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`
  ).bind(key, expiresAt).run();

  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first();
  return (row?.count ?? 0) > limit;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Stripe Checkout 途中で放置された注文のみ削除 */
async function cleanupStaleOrders(env) {
  await ensureRateLimitTable(env.DB);
  await env.DB.prepare(
    `DELETE FROM rate_limits WHERE expires_at < ?`
  ).bind(nowIso()).run();

  const result = await env.DB.prepare(
    `DELETE FROM orders
     WHERE payment_status IN ('未決済', '失敗')
       AND stripe_session_id IS NOT NULL
       AND status = '予約'
       AND created_at < datetime('now', '+9 hours', ?)`
  ).bind(`-${STALE_STRIPE_ORDER_HOURS} hours`).run();

  return result.meta?.changes ?? 0;
}

async function getShippingMap(db) {
  const rows = await db.prepare('SELECT prefecture, fee FROM shipping_rates').all();
  const map = Object.fromEntries(PREFECTURES.map((p) => [p, 0]));
  for (const r of rows.results ?? []) {
    if (PREFECTURES.includes(r.prefecture)) map[r.prefecture] = r.fee;
  }
  return map;
}

function getShippingRegionsFromMap(prefectureMap) {
  return SHIPPING_REGIONS.map((region) => ({
    id: region.id,
    name: region.name,
    prefectures: region.prefectures,
    fee: prefectureMap[region.prefectures[0]] ?? 0,
  }));
}

function findShippingRegion(id) {
  return SHIPPING_REGIONS.find((r) => r.id === id);
}

const STRIPE_API = 'https://api.stripe.com/v1';

function isStripeEnabled(env) {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 0;
}

async function stripeFetch(env, path, options = {}) {
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

async function verifyStripeWebhook(rawBody, signatureHeader, secret) {
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
  origin, orderId, email, qty, unitPrice, taxRate, taxAmount, shippingFee,
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
    params.append(`line_items[${idx}][price_data][product_data][name]`, `消費税（${taxRate}%）`);
    idx += 1;
  }
  if (shippingFee > 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(shippingFee));
    params.append(`line_items[${idx}][price_data][product_data][name]`, '送料');
  }

  return params;
}

async function createStripeCheckoutSession(env, opts) {
  const body = buildStripeCheckoutParams(opts);
  return stripeFetch(env, '/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

function stripeOrderId(session) {
  return session?.metadata?.order_id || session?.client_reference_id || null;
}

function isStripeSessionPaid(session) {
  return session?.payment_status === 'paid' || session?.status === 'complete';
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

function parseReserveBody(body) {
  if (!body) return { error: 'Invalid JSON' };

  const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
  if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
    return { error: '必須項目が不足しています' };
  }
  if (!PREFECTURES.includes(prefecture)) {
    return { error: '都道府県が不正です' };
  }
  if (
    last_name.length > MAX_LEN.name || first_name.length > MAX_LEN.name ||
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
  if (isNaN(qty) || qty < 1 || qty > 5) {
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
      last_name_kana: body.last_name_kana || '',
      first_name_kana: body.first_name_kana || '',
      qty,
    },
  };
}

async function loadPricing(env, prefecture, qty) {
  const inv = await env.DB.prepare(
    'SELECT stock, sold_out, unit_price, tax_rate FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  if (!inv || inv.sold_out || inv.stock < qty) {
    return { error: '在庫が不足しています', status: 409 };
  }

  const rate = await env.DB.prepare(
    'SELECT fee FROM shipping_rates WHERE prefecture = ?'
  ).bind(prefecture).first();

  const unitPrice = inv.unit_price ?? 0;
  const taxRate = inv.tax_rate ?? 10;
  const shippingFee = rate?.fee ?? 0;
  const { taxAmount, totalAmount } = calcOrderAmount(unitPrice, qty, taxRate, shippingFee);

  return { unitPrice, taxRate, shippingFee, taxAmount, totalAmount };
}

async function handleCheckout(request, env, CORS) {
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

  const { unitPrice, taxRate, shippingFee, taxAmount, totalAmount } = pricing;
  if (unitPrice <= 0) {
    return json({ error: '商品単価が設定されていません。管理画面で価格を設定してください。' }, 503, CORS);
  }

  const order_id = generateOrderId();
  const origin = new URL(request.url).origin;

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
      shippingFee,
    });
  } catch {
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  if (!session?.url || !session?.id) {
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  await env.DB.prepare(
    `INSERT INTO orders (
      order_id, last_name, first_name, last_name_kana, first_name_kana,
      email, phone, postal, prefecture, address1, address2, note,
      quantity, unit_price, shipping_fee, tax_amount, total_amount,
      payment_status, stripe_session_id, status, admin_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未決済', ?, '予約', '')`
  ).bind(
    order_id,
    last_name, first_name, last_name_kana, first_name_kana,
    email, phone, postal, prefecture, address1, address2, note,
    qty, unitPrice, shippingFee, taxAmount, totalAmount,
    session.id,
  ).run();

  return json({
    order_id,
    session_url: session.url,
    total_amount: totalAmount,
  }, 200, CORS);
}

async function handleCheckoutReturn(env, CORS, sessionId) {
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
    const paymentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
    const result = await confirmOrderPayment(env, orderId, {
      sessionId: session.id,
      paymentId,
    });
    if (result.error) return json({ error: result.error }, result.status, CORS);
    return json({
      ok: true,
      order_id: orderId,
      payment_status: '決済済',
      session_status: session.status,
    }, 200, CORS);
  }

  if (session.status === 'expired') {
    return json({ ok: false, order_id: orderId, payment_status: '失敗', session_status: session.status }, 200, CORS);
  }

  return json({
    ok: false,
    order_id: orderId,
    payment_status: '未決済',
    session_status: session.status,
    message: '決済が完了していません。もう一度お試しください。',
  }, 200, CORS);
}

async function handleStripeWebhook(request, env) {
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

  if (type === 'checkout.session.completed' && session) {
    const orderId = stripeOrderId(session);
    if (orderId && isStripeSessionPaid(session)) {
      const paymentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      await confirmOrderPayment(env, orderId, {
        sessionId: session.id,
        paymentId,
      });
    }
  }

  if (type === 'checkout.session.expired' && session) {
    const orderId = stripeOrderId(session);
    if (orderId) {
      await env.DB.prepare(
        `UPDATE orders SET payment_status = '失敗' WHERE order_id = ? AND payment_status = '未決済'`
      ).bind(orderId).run();
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function confirmOrderPayment(env, orderId, { sessionId = null, paymentId = null } = {}) {
  const order = await env.DB.prepare(
    `SELECT order_id, quantity, payment_status, status FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  if (!order) return { error: '予約が見つかりません', status: 404 };
  if (order.payment_status === '決済済') {
    return { ok: true, order_id: orderId, already: true };
  }
  if (order.status === 'キャンセル') {
    return { error: 'キャンセル済みの予約です', status: 409 };
  }

  const qty = order.quantity;
  if (!(await decrementStock(env.DB, qty))) {
    return { error: '在庫が不足しているため決済を確定できません', status: 409 };
  }

  await env.DB.prepare(
    `UPDATE orders SET
      payment_status = '決済済',
      stripe_session_id = COALESCE(?, stripe_session_id),
      stripe_payment_id = COALESCE(?, stripe_payment_id)
     WHERE order_id = ? AND payment_status != '決済済'`
  ).bind(sessionId, paymentId, orderId).run();

  return { ok: true, order_id: orderId };
}

async function handleStock(env, CORS) {
  const row = await env.DB.prepare(
    'SELECT stock, sold_out, unit_price, tax_rate FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  if (!row) return json({ error: 'Not found' }, 404, CORS);

  const shipping = await getShippingMap(env.DB);

  return json({
    stock: row.stock,
    sold_out: row.sold_out === 1,
    unit_price: row.unit_price ?? 0,
    tax_rate: row.tax_rate ?? 10,
    shipping,
    checkout_enabled: isStripeEnabled(env),
  }, 200, CORS);
}

async function handleAdminDashboard(env, CORS) {
  const inv = await env.DB.prepare(
    'SELECT stock, sold_out, unit_price, tax_rate FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  let sold = { sold: 0 };
  let orderCount = { cnt: 0 };
  try {
    sold = await env.DB.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS sold FROM orders WHERE status != 'キャンセル'`
    ).first() ?? { sold: 0 };
    orderCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM orders WHERE status != 'キャンセル'`
    ).first() ?? { cnt: 0 };
  } catch {
    sold = await env.DB.prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS sold FROM orders'
    ).first() ?? { sold: 0 };
    orderCount = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM orders'
    ).first() ?? { cnt: 0 };
  }

  const shippingMap = await getShippingMap(env.DB);

  return json({
    inventory: {
      stock: inv?.stock ?? 0,
      sold_out: inv?.sold_out === 1,
      unit_price: inv?.unit_price ?? 0,
      tax_rate: inv?.tax_rate ?? 10,
    },
    shipping_regions: getShippingRegionsFromMap(shippingMap),
    sold: sold?.sold ?? 0,
    order_count: orderCount?.cnt ?? 0,
  }, 200, CORS);
}

const ORDER_SELECT = `order_id, last_name, first_name, last_name_kana, first_name_kana,
  email, phone, postal, prefecture, address1, address2, note,
  quantity, unit_price, shipping_fee, tax_amount, total_amount, status, admin_note, created_at`;

async function handleAdminOrders(env, CORS, url) {
  const filter = url.searchParams.get('filter') === 'cancelled' ? 'cancelled' : 'active';
  const query = filter === 'cancelled'
    ? `SELECT ${ORDER_SELECT} FROM orders WHERE status = 'キャンセル' ORDER BY id DESC LIMIT 100`
    : `SELECT ${ORDER_SELECT} FROM orders WHERE status != 'キャンセル' ORDER BY id DESC LIMIT 100`;

  const rows = await env.DB.prepare(query).all();
  return json({ orders: rows.results ?? [], filter }, 200, CORS);
}

async function handleAdminOrderUpdate(request, env, CORS, orderId) {
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
  const stockWasAllocated = order.payment_status === '決済済';

  if (oldStatus !== 'キャンセル' && status === 'キャンセル') {
    const stmts = [
      env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
      ).bind(status, adminNote, orderId),
    ];
    if (stockWasAllocated) {
      stmts.push(
        env.DB.prepare(
          `UPDATE inventory SET
            stock = stock + ?,
            sold_out = CASE WHEN stock + ? > 0 THEN 0 ELSE sold_out END
           WHERE product_id = ?`
        ).bind(qty, qty, PRODUCT_ID),
      );
    }
    await env.DB.batch(stmts);
  } else if (oldStatus === 'キャンセル' && status !== 'キャンセル') {
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

  const updated = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  return json({ order: updated }, 200, CORS);
}

async function handleAdminOrderDelete(env, CORS, orderId) {
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

async function handleAdminInventoryUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const stock = parseInt(body.stock, 10);
  const unitPrice = parseInt(body.unit_price, 10);
  const taxRate = parseInt(body.tax_rate, 10);
  if (isNaN(stock) || stock < 0) {
    return json({ error: '在庫数の値が不正です' }, 400, CORS);
  }
  if (isNaN(unitPrice) || unitPrice < 0) {
    return json({ error: '単価の値が不正です' }, 400, CORS);
  }
  if (unitPrice === 0 && !body.sold_out && stock > 0) {
    return json({ error: '単価は1円以上で設定してください' }, 400, CORS);
  }
  if (isNaN(taxRate) || taxRate < 0 || taxRate > 100) {
    return json({ error: '税率の値が不正です' }, 400, CORS);
  }

  const soldOut = body.sold_out ? 1 : (stock <= 0 ? 1 : 0);

  await env.DB.prepare(
    `UPDATE inventory SET stock = ?, sold_out = ?, unit_price = ?, tax_rate = ? WHERE product_id = ?`
  ).bind(stock, soldOut, unitPrice, taxRate, PRODUCT_ID).run();

  return json({ stock, sold_out: soldOut === 1, unit_price: unitPrice, tax_rate: taxRate }, 200, CORS);
}

async function handleAdminShippingUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.rates)) {
    return json({ error: '送料データが不正です' }, 400, CORS);
  }

  const updates = [];
  for (const item of body.rates) {
    const region = findShippingRegion(item.region);
    if (!region) {
      return json({ error: `不正な地域: ${item.region}` }, 400, CORS);
    }
    const fee = parseInt(item.fee, 10);
    if (isNaN(fee) || fee < 0) {
      return json({ error: `${region.name} の送料が不正です` }, 400, CORS);
    }
    for (const prefecture of region.prefectures) {
      updates.push({ prefecture, fee });
    }
  }

  const stmts = updates.map(({ prefecture, fee }) =>
    env.DB.prepare(
      `INSERT INTO shipping_rates (prefecture, fee) VALUES (?, ?)
       ON CONFLICT(prefecture) DO UPDATE SET fee = excluded.fee`
    ).bind(prefecture, fee)
  );

  if (stmts.length) await env.DB.batch(stmts);

  const shippingMap = await getShippingMap(env.DB);
  return json({ shipping_regions: getShippingRegionsFromMap(shippingMap) }, 200, CORS);
}

const BOOKKEEPING_ORDER_FILTER = `status != 'キャンセル' AND payment_status = '決済済'`;

function parseBookkeepingYear(url) {
  const year = parseInt(url.searchParams.get('year') || '', 10);
  if (Number.isNaN(year) || year < 2000 || year > 2100) return null;
  return year;
}

function sumBookkeepingMonths(months) {
  return months.reduce((acc, m) => ({
    order_count: acc.order_count + m.order_count,
    total_quantity: acc.total_quantity + m.total_quantity,
    product_subtotal: acc.product_subtotal + m.product_subtotal,
    tax_amount: acc.tax_amount + m.tax_amount,
    shipping_income: acc.shipping_income + m.shipping_income,
    total_amount: acc.total_amount + m.total_amount,
    actual_shipping: acc.actual_shipping + m.actual_shipping,
  }), {
    order_count: 0,
    total_quantity: 0,
    product_subtotal: 0,
    tax_amount: 0,
    shipping_income: 0,
    total_amount: 0,
    actual_shipping: 0,
  });
}

async function loadBookkeepingMonths(db, year) {
  const salesRows = await db.prepare(
    `SELECT strftime('%Y-%m', created_at) AS ym,
            COUNT(*) AS order_count,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(unit_price * quantity), 0) AS product_subtotal,
            COALESCE(SUM(tax_amount), 0) AS tax_amount,
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
      shipping_income: shippingIncome,
      total_amount: sales.total_amount ?? 0,
      actual_shipping: actualShipping,
      shipping_margin: shippingIncome - actualShipping,
      note: exp.note ?? '',
    });
  }
  return months;
}

async function handleAdminBookkeeping(env, CORS, url) {
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

async function handleAdminBookkeepingExpensesUpdate(request, env, CORS) {
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

  const year = parseInt(body.expenses[0]?.year_month?.slice(0, 4), 10)
    || new Date().getFullYear();
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
    '年月,件数,本数,商品売上(税抜),消費税(商品),送料収入,売上合計,実配送費,送料差額,メモ',
    ...months.map((m) => [
      m.year_month,
      m.order_count,
      m.total_quantity,
      m.product_subtotal,
      m.tax_amount,
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
      totals.shipping_income,
      totals.total_amount,
      totals.actual_shipping,
      totals.shipping_income - totals.actual_shipping,
      '',
    ].map(csvEscape).join(','),
    '',
    '【注文明細（決済済み）】',
    '予約番号,日時,数量,税抜単価,商品売上(税抜),消費税,送料収入,合計,都道府県',
    ...orders.map((o) => [
      o.order_id,
      o.created_at,
      o.quantity,
      o.unit_price,
      o.unit_price * o.quantity,
      o.tax_amount,
      o.shipping_fee,
      o.total_amount,
      o.prefecture,
    ].map(csvEscape).join(',')),
  ];
  return lines.join('\r\n');
}

async function handleAdminBookkeepingExport(env, CORS, url) {
  const year = parseBookkeepingYear(url);
  if (!year) return json({ error: '年が不正です' }, 400, CORS);

  const months = await loadBookkeepingMonths(env.DB, year);
  const totals = sumBookkeepingMonths(months);

  const orderRows = await env.DB.prepare(
    `SELECT order_id, created_at, quantity, unit_price, tax_amount,
            shipping_fee, total_amount, prefecture
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

async function handleAdminStats(env, CORS) {
  const rows = await env.DB.prepare(
    `SELECT strftime('%Y', created_at) AS year,
            COUNT(*) AS order_count,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(total_amount), 0) AS amount
     FROM orders
     WHERE status != 'キャンセル'
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

async function handleApi(request, env) {
  const url = new URL(request.url);
  const isAdmin = url.pathname.startsWith('/api/admin/');
  const CORS = buildCors(env, request, { credentials: isAdmin });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (!env.DB) {
    return json({ error: 'DB binding が設定されていません' }, 500, CORS);
  }

  const ip = clientIp(request);
  const isStripeWebhook = !!request.headers.get('Stripe-Signature');

  if (!isStripeWebhook) {
    if (url.pathname === '/api/reserve' && request.method === 'POST') {
      if (await isRateLimited(env, 'reserve', ip, 10, 1)) {
        return json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' }, 429, CORS);
      }
    }
    if (url.pathname === '/api/stock' && request.method === 'GET' && !url.searchParams.get('session_id')) {
      if (await isRateLimited(env, 'stock', ip, 60, 1)) {
        return json({ error: 'リクエストが多すぎます' }, 429, CORS);
      }
    }
  }

  if (url.pathname === '/api/stock' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session_id');
    if (sessionId) return handleCheckoutReturn(env, CORS, sessionId);
    return handleStock(env, CORS);
  }

  if (url.pathname === '/api/reserve' && request.method === 'POST') {
    if (request.headers.get('Stripe-Signature')) {
      return handleStripeWebhook(request, env);
    }
    if (isStripeEnabled(env)) return handleCheckout(request, env, CORS);
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  if (isAdmin) {
    if (url.pathname === '/api/admin/session' && request.method === 'GET') {
      return handleAdminSessionCheck(request, env, CORS);
    }

    const auth = await verifyAdminAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status, CORS);

    if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
      return handleAdminDashboard(env, CORS);
    }

    if (url.pathname === '/api/admin/inventory' && request.method === 'PUT') {
      return handleAdminInventoryUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/shipping' && request.method === 'PUT') {
      return handleAdminShippingUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
      return handleAdminStats(env, CORS);
    }

    if (url.pathname === '/api/admin/bookkeeping' && request.method === 'GET') {
      return handleAdminBookkeeping(env, CORS, url);
    }

    if (url.pathname === '/api/admin/bookkeeping/expenses' && request.method === 'PUT') {
      return handleAdminBookkeepingExpensesUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/bookkeeping/export.csv' && request.method === 'GET') {
      return handleAdminBookkeepingExport(env, CORS, url);
    }

    if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
      return handleAdminOrders(env, CORS, url);
    }

    const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (orderMatch && request.method === 'PUT') {
      return handleAdminOrderUpdate(request, env, CORS, orderMatch[1]);
    }
    if (orderMatch && request.method === 'DELETE') {
      return handleAdminOrderDelete(env, CORS, orderMatch[1]);
    }
  }

  return json({ error: 'Not found' }, 404, CORS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // Worker が /* で受けた場合: Pages（HTML・CSS 等）へそのまま通す
    return fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupStaleOrders(env));
  },
};
