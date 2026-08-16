/**
 * 失敗した運営向け購入通知を ADMIN_NOTIFY 宛に再送する。
 * Usage: node scripts/send-admin-purchase-batch.mjs --limit 200 --delay-ms 350
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = 'e1b3f72b4806b9ee6db348e090df9590';
const TO = 'shingo.satokimi2021@gmail.com';
const FROM = { address: 'info@yellow-pearl.com', name: 'Yellow Pearl' };

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const LIMIT = Number(arg('--limit', '200'));
const DELAY_MS = Number(arg('--delay-ms', '350'));

function oauthToken() {
  const p = path.join(
    process.env.USERPROFILE || process.env.HOME,
    'AppData/Roaming/xdg.config/.wrangler/config/default.toml',
  );
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('oauth_token not found');
  return m[1];
}

function yen(n) {
  return Number(n ?? 0).toLocaleString('ja-JP');
}

function address(o) {
  const line2 = o.address2 ? ` ${o.address2}` : '';
  return `〒${o.postal} ${o.prefecture}${o.address1}${line2}`;
}

function bodies(o) {
  const name = `${o.last_name} ${o.first_name}`;
  const text = [
    '【購入通知】Yellow Pearl に新しい決済がありました。',
    '',
    `予約番号: ${o.order_id}`,
    `お名前: ${name}`,
    `メール: ${o.email}`,
    `電話: ${o.phone}`,
    `数量: ${o.quantity} 本`,
    `合計: ${yen(o.total_amount)} 円（税込・送料込）`,
    '',
    '【お届け先】',
    address(o),
    '',
    '管理画面の予約一覧で詳細を確認できます。',
  ].join('\n');

  const html = `
    <p><strong>【購入通知】</strong>Yellow Pearl に新しい決済がありました。</p>
    <ul>
      <li><strong>予約番号:</strong> ${o.order_id}</li>
      <li><strong>お名前:</strong> ${name}</li>
      <li><strong>メール:</strong> ${o.email}</li>
      <li><strong>電話:</strong> ${o.phone}</li>
      <li><strong>数量:</strong> ${o.quantity} 本</li>
      <li><strong>合計:</strong> ${yen(o.total_amount)} 円（税込・送料込）</li>
    </ul>
    <p><strong>お届け先</strong><br>
    ${address(o)}</p>
    <p style="color:#666;font-size:12px">管理画面の予約一覧で詳細を確認できます。</p>
  `.trim();

  return { text, html };
}

function d1Json(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'yellow-pearl-db', '--remote', '--json', '--command', sql],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block?.results ?? [];
}

function api(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.cloudflare.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(d);
          } catch {
            json = { raw: d };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const sql = `
SELECT o.order_id, o.last_name, o.first_name, o.email, o.quantity, o.total_amount,
  o.phone, o.postal, o.prefecture, o.address1, o.address2
FROM orders o
WHERE o.payment_status = '決済済'
  AND o.archived_at IS NULL
  AND EXISTS (
    SELECT 1 FROM order_events e
    WHERE e.order_id = o.order_id AND e.event_type = 'admin_purchase_email_failed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM order_events e
    WHERE e.order_id = o.order_id AND e.event_type = 'admin_purchase_email_sent'
  )
ORDER BY o.created_at ASC
LIMIT ${Number.isFinite(LIMIT) ? LIMIT : 200}
`.replace(/\s+/g, ' ').trim();

const token = oauthToken();
const rows = d1Json(sql);
console.log(JSON.stringify({ pending_fetched: rows.length, limit: LIMIT, to: TO }));

let sent = 0;
let failed = 0;
for (const o of rows) {
  const { text, html } = bodies(o);
  const subject = `【購入】${o.quantity}本・${yen(o.total_amount)}円（${o.order_id}）`;
  const res = await api(
    'POST',
    `/client/v4/accounts/${ACCOUNT}/email/sending/send`,
    {
      to: TO,
      from: FROM,
      subject,
      text,
      html,
    },
    token,
  );

  if (res.status >= 200 && res.status < 300 && res.json?.success !== false) {
    d1Json(
      `INSERT INTO order_events (order_id, event_type, detail) VALUES ('${o.order_id}', 'admin_purchase_email_sent', '${TO}')`,
    );
    sent += 1;
    console.log(JSON.stringify({ ok: true, order_id: o.order_id }));
  } else {
    failed += 1;
    const msg = res.json?.errors?.[0]?.message || JSON.stringify(res.json);
    console.log(JSON.stringify({ ok: false, order_id: o.order_id, status: res.status, error: msg }));
    if (/quota|throttl|daily|rate.?limit/i.test(String(msg))) {
      console.log(JSON.stringify({ stopped: 'quota' }));
      break;
    }
  }
  if (DELAY_MS > 0) await sleep(DELAY_MS);
}

console.log(JSON.stringify({ done: true, sent, failed }));
