// 本番ドメインに変更すること（例: 'https://yellow-pearl.pages.dev'）
const ALLOWED_ORIGIN = '*';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 入力の最大文字数
const MAX_LEN = { name: 50, email: 100, phone: 20, postal: 10, address: 200, note: 500 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `YP-${ts}-${rand}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // GET /api/stock → 在庫情報
    if (url.pathname === '/api/stock' && request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT stock, total, sold_out FROM inventory WHERE product_id = ?'
      ).bind('yellow-pearl').first();

      if (!row) return json({ error: 'Not found' }, 404);

      return json({
        stock: row.stock,
        total: row.total,
        sold_out: row.sold_out === 1,
        remaining_pct: Math.round((row.stock / row.total) * 100),
      });
    }

    // POST /api/reserve → 予約受付
    if (url.pathname === '/api/reserve' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Invalid JSON' }, 400);

      const { last_name, first_name, email, phone, postal, prefecture, address1, quantity = 1 } = body;
      if (!last_name || !first_name || !email || !phone || !postal || !prefecture || !address1) {
        return json({ error: '必須項目が不足しています' }, 400);
      }

      // 入力長チェック
      if (
        last_name.length > MAX_LEN.name || first_name.length > MAX_LEN.name ||
        email.length > MAX_LEN.email || phone.length > MAX_LEN.phone ||
        postal.length > MAX_LEN.postal || address1.length > MAX_LEN.address ||
        (body.address2 || '').length > MAX_LEN.address ||
        (body.note || '').length > MAX_LEN.note
      ) {
        return json({ error: '入力が長すぎます' }, 400);
      }

      // メール形式チェック
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'メールアドレスの形式が正しくありません' }, 400);
      }

      // 数量チェック
      const qty = parseInt(quantity, 10);
      if (isNaN(qty) || qty < 1 || qty > 5) {
        return json({ error: '数量が不正です' }, 400);
      }

      // 在庫確認
      const inv = await env.DB.prepare(
        'SELECT stock, sold_out FROM inventory WHERE product_id = ?'
      ).bind('yellow-pearl').first();

      if (!inv || inv.sold_out || inv.stock < qty) {
        return json({ error: '在庫が不足しています' }, 409);
      }

      const order_id = generateOrderId();

      // 注文保存 + 在庫減算（トランザクション）
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (order_id, last_name, first_name, email, phone, postal, prefecture, address1, address2, note, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          order_id,
          last_name, first_name, email, phone, postal, prefecture,
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
        ).bind(qty, qty, 'yellow-pearl'),
      ]);

      return json({ order_id });
    }

    return json({ error: 'Not found' }, 404);
  },
};
