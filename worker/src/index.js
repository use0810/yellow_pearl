const DEFAULT_ORIGINS = 'https://yellow-pearl.com,https://www.yellow-pearl.com';
const PRODUCT_ID = 'yellow-pearl';
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
  const raw = env.ALLOWED_ORIGINS ?? env.ALLOWED_ORIGIN ?? DEFAULT_ORIGINS;
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
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `YP-${ts}-${rand}`;
}

const SITE_AUTH_REALM = 'Yellow Pearl';
const ADMIN_SESSION_COOKIE = 'yp_admin_session';
const MAX_ADMIN_LOGIN_FAILURES = 10;
const ADMIN_LOCK_MINUTES = 30;
const ADMIN_SESSION_HOURS = 12;

function isSitePasswordSet(env) {
  return typeof env.SITE_PASSWORD === 'string' && env.SITE_PASSWORD.length > 0;
}

function isBasicAuthorized(request, password) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return pass === password;
  } catch {
    return false;
  }
}

function basicAuthChallenge() {
  return new Response('認証が必要です', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${SITE_AUTH_REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** 管理画面・Stripe Webhook は Basic 認証スキップ */
function skipsSiteBasicAuth(pathname) {
  return pathname === '/admin.html'
    || pathname.startsWith('/admin')
    || pathname.startsWith('/api/admin/');
}

function skipsSiteBasicAuthRequest(request) {
  if (request.headers.get('Stripe-Signature')) return true;
  return skipsSiteBasicAuth(new URL(request.url).pathname);
}

function requireSiteBasicAuth(_request, _env) {
  return null;
}

/** Cloudflare Access が付与する JWT を検証（Access 保護が前提） */
function verifyAccessJwt(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;

  try {
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(pad));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    if (env.ACCESS_AUD && payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.ACCESS_AUD)) return null;
    }
    return { ok: true, via: 'access' };
  } catch {
    return null;
  }
}

function adminPasswordConfigured(env) {
  return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length > 0;
}

function adminUsername(env) {
  const user = env.ADMIN_USER?.trim();
  return user || 'admin';
}

function parseCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sessionCookie(token, maxAgeSec) {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

function clearSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`;
}

function passwordsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function getLoginAttempt(env, username) {
  return env.DB.prepare(
    'SELECT username, failures, locked_until FROM admin_login_attempts WHERE username = ?'
  ).bind(username).first();
}

async function isAdminAccountLocked(env, username) {
  const row = await getLoginAttempt(env, username);
  if (!row?.locked_until) return false;
  if (row.locked_until > nowIso()) return true;
  await env.DB.prepare(
    'UPDATE admin_login_attempts SET failures = 0, locked_until = NULL WHERE username = ?'
  ).bind(username).run();
  return false;
}

async function recordAdminLoginFailure(env, username) {
  const row = await getLoginAttempt(env, username);
  const failures = (row?.failures ?? 0) + 1;
  if (failures >= MAX_ADMIN_LOGIN_FAILURES) {
    const lockedUntil = addMinutesIso(ADMIN_LOCK_MINUTES);
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts (username, failures, locked_until)
       VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`
    ).bind(username, failures, lockedUntil).run();
    return { locked: true, failures };
  }
  await env.DB.prepare(
    `INSERT INTO admin_login_attempts (username, failures, locked_until)
     VALUES (?, ?, NULL)
     ON CONFLICT(username) DO UPDATE SET failures = excluded.failures`
  ).bind(username, failures).run();
  return { locked: false, failures };
}

async function clearAdminLoginFailures(env, username) {
  await env.DB.prepare(
    'DELETE FROM admin_login_attempts WHERE username = ?'
  ).bind(username).run();
}

async function createAdminSession(env) {
  const token = crypto.randomUUID();
  const expiresAt = addMinutesIso(ADMIN_SESSION_HOURS * 60);
  await env.DB.prepare(
    'INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)'
  ).bind(token, expiresAt).run();
  return { token, maxAgeSec: ADMIN_SESSION_HOURS * 3600 };
}

async function verifyAdminSession(request, env) {
  const token = parseCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT token, expires_at FROM admin_sessions WHERE token = ?'
  ).bind(token).first();
  if (!row || row.expires_at <= nowIso()) {
    if (row) {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
    }
    return null;
  }
  return { ok: true, via: 'session' };
}

async function verifyAdminAuth(request, env) {
  const access = verifyAccessJwt(request, env);
  if (access) return access;
  const session = await verifyAdminSession(request, env);
  if (session) return session;
  return { error: '認証が必要です', status: 401 };
}

async function handleAdminLogin(request, env, CORS) {
  if (!adminPasswordConfigured(env)) {
    return json({ error: '管理者ログインは設定されていません' }, 503, CORS);
  }

  const body = await request.json().catch(() => null);
  const username = (body?.username || '').trim();
  const password = body?.password || '';
  const expectedUser = adminUsername(env);

  if (!username || !password) {
    return json({ error: 'ユーザー名とパスワードを入力してください' }, 400, CORS);
  }

  if (await isAdminAccountLocked(env, expectedUser)) {
    return json({
      error: 'ログイン試行回数の上限に達しました。しばらくしてからお試しください。',
      locked: true,
    }, 423, CORS);
  }

  const valid = username === expectedUser && passwordsEqual(password, env.ADMIN_PASSWORD);
  if (!valid) {
    const result = await recordAdminLoginFailure(env, expectedUser);
    if (result.locked) {
      return json({
        error: 'ログイン試行回数の上限に達しました。しばらくしてからお試しください。',
        locked: true,
      }, 423, CORS);
    }
    return json({ error: 'ユーザー名またはパスワードが正しくありません' }, 401, CORS);
  }

  await clearAdminLoginFailures(env, expectedUser);
  const session = await createAdminSession(env);
  return json({ ok: true }, 200, {
    ...CORS,
    'Set-Cookie': sessionCookie(session.token, session.maxAgeSec),
  });
}

async function handleAdminLogout(request, env, CORS) {
  const token = parseCookie(request, ADMIN_SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
  }
  return json({ ok: true }, 200, { ...CORS, 'Set-Cookie': clearSessionCookie() });
}

async function handleAdminSessionCheck(request, env, CORS) {
  const auth = await verifyAdminAuth(request, env);
  if (auth.error) return json({ authenticated: false }, 401, CORS);
  return json({ authenticated: true, via: auth.via }, 200, CORS);
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

/** Stripe Checkout 途中で放置された注文のみ削除（現金予約は残す） */
async function cleanupStaleOrders(env) {
  await ensureRateLimitTable(env.DB);
  await env.DB.prepare(
    `DELETE FROM rate_limits WHERE expires_at < ?`
  ).bind(nowIso()).run();

  const result = await env.DB.prepare(
    `DELETE FROM orders
     WHERE payment_status IN ('未決済', '失敗')
       AND komoju_session_id IS NOT NULL
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
  origin, orderId, email, qty, unitPrice, taxAmount, shippingFee,
}) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${origin}/cart.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${origin}/cart.html?cancelled=1`);
  params.append('customer_email', email);
  params.append('client_reference_id', orderId);
  params.append('metadata[order_id]', orderId);
  params.append('locale', 'ja');
  params.append('customer_creation', 'always');

  params.append('line_items[0][quantity]', String(qty));
  params.append('line_items[0][price_data][currency]', 'jpy');
  params.append('line_items[0][price_data][unit_amount]', String(unitPrice));
  params.append('line_items[0][price_data][product_data][name]', 'Yellow Pearl（イエローパール）');

  let idx = 1;
  if (taxAmount > 0) {
    params.append(`line_items[${idx}][quantity]`, '1');
    params.append(`line_items[${idx}][price_data][currency]`, 'jpy');
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(taxAmount));
    params.append(`line_items[${idx}][price_data][product_data][name]`, '消費税');
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

  const { unitPrice, shippingFee, taxAmount, totalAmount } = pricing;
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
      taxAmount,
      shippingFee,
    });
  } catch (e) {
    return json({ error: e.message || '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  if (!session?.url || !session?.id) {
    return json({ error: '決済セッションの作成に失敗しました' }, 502, CORS);
  }

  await env.DB.prepare(
    `INSERT INTO orders (
      order_id, last_name, first_name, last_name_kana, first_name_kana,
      email, phone, postal, prefecture, address1, address2, note,
      quantity, unit_price, shipping_fee, tax_amount, total_amount,
      payment_status, komoju_session_id, status, admin_note
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
  } catch (e) {
    return json({ error: e.message || '決済情報の取得に失敗しました' }, 502, CORS);
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
      komoju_session_id = COALESCE(?, komoju_session_id),
      komoju_payment_id = COALESCE(?, komoju_payment_id)
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
    stripe_enabled: isStripeEnabled(env),
  }, 200, CORS);
}

async function handleReserve(request, env, CORS) {
  const body = await request.json().catch(() => null);
  const parsed = parseReserveBody(body);
  if (parsed.error) return json({ error: parsed.error }, 400, CORS);

  const {
    last_name, first_name, email, phone, postal, prefecture, address1,
    address2, note, last_name_kana, first_name_kana, qty,
  } = parsed.data;

  const pricing = await loadPricing(env, prefecture, qty);
  if (pricing.error) return json({ error: pricing.error }, pricing.status, CORS);

  const { unitPrice, shippingFee, taxAmount, totalAmount } = pricing;
  const order_id = generateOrderId();

  if (!(await decrementStock(env.DB, qty))) {
    return json({ error: '在庫が不足しています' }, 409, CORS);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO orders (
        order_id, last_name, first_name, last_name_kana, first_name_kana,
        email, phone, postal, prefecture, address1, address2, note,
        quantity, unit_price, shipping_fee, tax_amount, total_amount,
        payment_status, status, admin_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未決済', '予約', '')`
    ).bind(
      order_id,
      last_name, first_name, last_name_kana, first_name_kana,
      email, phone, postal, prefecture, address1, address2, note,
      qty, unitPrice, shippingFee, taxAmount, totalAmount,
    ).run();
  } catch {
    await incrementStock(env.DB, qty);
    return json({ error: '予約の保存に失敗しました' }, 500, CORS);
  }

  return json({ order_id, unit_price: unitPrice, tax_amount: taxAmount, shipping_fee: shippingFee, total_amount: totalAmount }, 200, CORS);
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
    'SELECT quantity, status, payment_status, komoju_session_id FROM orders WHERE order_id = ?'
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);

  const oldStatus = order.status || '予約';
  const qty = order.quantity;
  const stockWasAllocated = order.payment_status === '決済済'
    || (order.payment_status === '未決済' && !order.komoju_session_id);

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
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      if (await isRateLimited(env, 'admin_login', ip, 10, 5)) {
        return json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' }, 429, CORS);
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
    return handleReserve(request, env, CORS);
  }

  if (isAdmin) {
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      return handleAdminLogin(request, env, CORS);
    }
    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return handleAdminLogout(request, env, CORS);
    }
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

    const authFail = requireSiteBasicAuth(request, env);
    if (authFail) return authFail;

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
