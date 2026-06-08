const DEFAULT_ORIGIN = '*';
const PRODUCT_ID = 'yellow-pearl';
const MAX_RESERVE_PER_HOUR = 5;
const MAX_ADMIN_PER_MIN = 30;

const MAX_LEN = { name: 50, email: 100, phone: 20, postal: 10, address: 200, note: 500 };

function buildCors(env, request, { credentials = false } = {}) {
  const allowed = env.ALLOWED_ORIGIN ?? DEFAULT_ORIGIN;
  const origin = request?.headers?.get('Origin');
  const allowOrigin = allowed === '*' && origin ? origin : allowed;
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (credentials) headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '0.0.0.0';
}

function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `YP-${ts}-${rand}`;
}

/** Cloudflare Access が付与する JWT を検証（Access 保護が前提） */
function verifyAccess(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return { error: '認証が必要です', status: 401 };

  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { error: '認証が切れました', status: 401 };
    }
    if (env.ACCESS_AUD && payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.ACCESS_AUD)) {
        return { error: '認証が無効です', status: 403 };
      }
    }
    return { email: payload.email, ip: getClientIp(request) };
  } catch {
    return { error: '認証が必要です', status: 401 };
  }
}

async function countRecent(db, ip, minutes, endpoint) {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM rate_limits
     WHERE ip = ? AND endpoint = ?
     AND attempted_at > datetime('now', '+9 hours', '-' || ? || ' minutes')`
  ).bind(ip, endpoint, minutes).first();
  return row?.cnt ?? 0;
}

async function recordRateLimit(db, ip, endpoint) {
  await db.prepare(
    'INSERT INTO rate_limits (ip, endpoint) VALUES (?, ?)'
  ).bind(ip, endpoint).run();
  await db.prepare(
    `DELETE FROM rate_limits WHERE attempted_at <= datetime('now', '+9 hours', '-1 days')`
  ).run();
}

async function requireAdmin(db, request, env) {
  const auth = verifyAccess(request, env);
  if (auth.error) return auth;

  const hits = await countRecent(db, auth.ip, 1, 'admin');
  if (hits >= MAX_ADMIN_PER_MIN) return { error: 'リクエストが多すぎます', status: 429 };

  return auth;
}

async function handleStock(env, CORS) {
  const row = await env.DB.prepare(
    'SELECT stock, total, sold_out FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  if (!row) return json({ error: 'Not found' }, 404, CORS);

  return json({
    stock: row.stock,
    total: row.total,
    sold_out: row.sold_out === 1,
    remaining_pct: Math.round((row.stock / row.total) * 100),
  }, 200, CORS);
}

async function handleReserve(request, env, CORS) {
  const ip = getClientIp(request);
  const hits = await countRecent(env.DB, ip, 60, 'reserve');
  if (hits >= MAX_RESERVE_PER_HOUR) {
    return json({ error: '予約の上限に達しました。しばらくしてからお試しください。' }, 429, CORS);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
  if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
    return json({ error: '必須項目が不足しています' }, 400, CORS);
  }

  if (
    last_name.length > MAX_LEN.name || first_name.length > MAX_LEN.name ||
    email.length > MAX_LEN.email || phone.length > MAX_LEN.phone ||
    postal.length > MAX_LEN.postal || address1.length > MAX_LEN.address ||
    (body.address2 || '').length > MAX_LEN.address ||
    (body.note || '').length > MAX_LEN.note
  ) {
    return json({ error: '入力が長すぎます' }, 400, CORS);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'メールアドレスの形式が正しくありません' }, 400, CORS);
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1 || qty > 5) {
    return json({ error: '数量が不正です' }, 400, CORS);
  }

  const inv = await env.DB.prepare(
    'SELECT stock, sold_out FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  if (!inv || inv.sold_out || inv.stock < qty) {
    return json({ error: '在庫が不足しています' }, 409, CORS);
  }

  const order_id = generateOrderId();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (order_id, last_name, first_name, last_name_kana, first_name_kana, email, phone, postal, prefecture, address1, address2, note, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      order_id,
      last_name, first_name,
      body.last_name_kana || '', body.first_name_kana || '',
      email, phone, postal, prefecture,
      address1,
      body.address2 || '',
      body.note || '',
      qty
    ),
    env.DB.prepare(
      `UPDATE inventory SET
        stock = stock - ?,
        sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE 0 END
       WHERE product_id = ?`
    ).bind(qty, qty, PRODUCT_ID),
  ]);

  await recordRateLimit(env.DB, ip, 'reserve');
  return json({ order_id }, 200, CORS);
}

async function handleAdminDashboard(env, CORS) {
  const inv = await env.DB.prepare(
    'SELECT stock, total, sold_out FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  const sold = await env.DB.prepare(
    'SELECT COALESCE(SUM(quantity), 0) as sold FROM orders'
  ).first();

  const orderCount = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM orders'
  ).first();

  const recent = await env.DB.prepare(
    `SELECT order_id, last_name, first_name, quantity, created_at
     FROM orders ORDER BY id DESC LIMIT 20`
  ).all();

  return json({
    inventory: {
      stock: inv?.stock ?? 0,
      total: inv?.total ?? 0,
      sold_out: inv?.sold_out === 1,
    },
    sold: sold?.sold ?? 0,
    order_count: orderCount?.cnt ?? 0,
    recent_orders: recent.results ?? [],
  }, 200, CORS);
}

async function handleAdminInventoryUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const stock = parseInt(body.stock, 10);
  const total = parseInt(body.total, 10);
  if (isNaN(stock) || isNaN(total) || stock < 0 || total < 1 || stock > total) {
    return json({ error: '在庫数・総数の値が不正です' }, 400, CORS);
  }

  const soldOut = body.sold_out ? 1 : (stock <= 0 ? 1 : 0);

  await env.DB.prepare(
    `UPDATE inventory SET stock = ?, total = ?, sold_out = ? WHERE product_id = ?`
  ).bind(stock, total, soldOut, PRODUCT_ID).run();

  return json({ stock, total, sold_out: soldOut === 1 }, 200, CORS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAdmin = url.pathname.startsWith('/api/admin/');
    const CORS = buildCors(env, request, { credentials: isAdmin });

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/api/stock' && request.method === 'GET') {
      return handleStock(env, CORS);
    }

    if (url.pathname === '/api/reserve' && request.method === 'POST') {
      return handleReserve(request, env, CORS);
    }

    if (isAdmin) {
      const auth = await requireAdmin(env.DB, request, env);
      if (auth.error) return json({ error: auth.error }, auth.status, CORS);
      await recordRateLimit(env.DB, auth.ip, 'admin');

      if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
        return handleAdminDashboard(env, CORS);
      }

      if (url.pathname === '/api/admin/inventory' && request.method === 'PUT') {
        return handleAdminInventoryUpdate(request, env, CORS);
      }
    }

    return json({ error: 'Not found' }, 404, CORS);
  },
};
