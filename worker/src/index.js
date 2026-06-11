const DEFAULT_ORIGIN = '*';
const PRODUCT_ID = 'yellow-pearl';

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
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', ...headers },
  });
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
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(pad));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { error: '認証が切れました', status: 401 };
    }
    if (env.ACCESS_AUD && payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.ACCESS_AUD)) {
        return { error: '認証が無効です', status: 403 };
      }
    }
    return { ok: true };
  } catch {
    return { error: '認証が必要です', status: 401 };
  }
}

function calcOrderAmount(unitPrice, qty, taxRate, shippingFee) {
  const subtotal = unitPrice * qty;
  const taxAmount = Math.floor(subtotal * taxRate / 100);
  const totalAmount = subtotal + taxAmount + shippingFee;
  return { subtotal, taxAmount, totalAmount };
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
  }, 200, CORS);
}

async function handleReserve(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
  if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
    return json({ error: '必須項目が不足しています' }, 400, CORS);
  }

  if (!PREFECTURES.includes(prefecture)) {
    return json({ error: '都道府県が不正です' }, 400, CORS);
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
    'SELECT stock, sold_out, unit_price, tax_rate FROM inventory WHERE product_id = ?'
  ).bind(PRODUCT_ID).first();

  if (!inv || inv.sold_out || inv.stock < qty) {
    return json({ error: '在庫が不足しています' }, 409, CORS);
  }

  const rate = await env.DB.prepare(
    'SELECT fee FROM shipping_rates WHERE prefecture = ?'
  ).bind(prefecture).first();

  const unitPrice = inv.unit_price ?? 0;
  const taxRate = inv.tax_rate ?? 10;
  const shippingFee = rate?.fee ?? 0;
  const { taxAmount, totalAmount } = calcOrderAmount(unitPrice, qty, taxRate, shippingFee);
  const order_id = generateOrderId();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (order_id, last_name, first_name, last_name_kana, first_name_kana, email, phone, postal, prefecture, address1, address2, note, quantity, unit_price, shipping_fee, tax_amount, total_amount, status, admin_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '予約', '')`
    ).bind(
      order_id,
      last_name, first_name,
      body.last_name_kana || '', body.first_name_kana || '',
      email, phone, postal, prefecture,
      address1,
      body.address2 || '', body.note || '',
      qty, unitPrice, shippingFee, taxAmount, totalAmount
    ),
    env.DB.prepare(
      `UPDATE inventory SET
        stock = stock - ?,
        sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE 0 END
       WHERE product_id = ?`
    ).bind(qty, qty, PRODUCT_ID),
  ]);

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
    'SELECT quantity, status FROM orders WHERE order_id = ?'
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);

  const oldStatus = order.status || '予約';
  const qty = order.quantity;

  if (oldStatus !== 'キャンセル' && status === 'キャンセル') {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
      ).bind(status, adminNote, orderId),
      env.DB.prepare(
        `UPDATE inventory SET
          stock = stock + ?,
          sold_out = CASE WHEN stock + ? > 0 THEN 0 ELSE sold_out END
         WHERE product_id = ?`
      ).bind(qty, qty, PRODUCT_ID),
    ]);
  } else if (oldStatus === 'キャンセル' && status !== 'キャンセル') {
    const inv = await env.DB.prepare(
      'SELECT stock, sold_out FROM inventory WHERE product_id = ?'
    ).bind(PRODUCT_ID).first();

    if (!inv || inv.stock < qty) {
      return json({ error: '在庫が不足しているため、キャンセルから戻せません' }, 409, CORS);
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
      ).bind(status, adminNote, orderId),
      env.DB.prepare(
        `UPDATE inventory SET
          stock = stock - ?,
          sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE 0 END
         WHERE product_id = ?`
      ).bind(qty, qty, PRODUCT_ID),
    ]);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAdmin = url.pathname.startsWith('/api/admin/');
    const CORS = buildCors(env, request, { credentials: isAdmin });

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!env.DB) {
      return json({ error: 'DB binding が設定されていません' }, 500, CORS);
    }

    if (url.pathname === '/api/stock' && request.method === 'GET') {
      return handleStock(env, CORS);
    }

    if (url.pathname === '/api/reserve' && request.method === 'POST') {
      return handleReserve(request, env, CORS);
    }

    if (isAdmin) {
      const auth = verifyAccess(request, env);
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
    }

    return json({ error: 'Not found' }, 404, CORS);
  },
};
