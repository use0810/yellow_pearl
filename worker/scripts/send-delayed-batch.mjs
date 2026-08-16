/**
 * 遅延お詫び確認メールを D1 の未送信決済済へ送るワンショット。
 * Usage:
 *   node scripts/send-delayed-batch.mjs --limit 1
 *   node scripts/send-delayed-batch.mjs --limit 200 --delay-ms 400
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = 'e1b3f72b4806b9ee6db348e090df9590';
const PRODUCT = 'Yellow Pearl（イエローパール）';
const SHIPPING = '発送は2026年9月1日より順次行います。';
const FROM = { address: 'info@yellow-pearl.com', name: 'Yellow Pearl' };
const REPLY = 'shingo.satokimi2021@gmail.com';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const LIMIT = Number(arg('--limit', '1'));
const DELAY_MS = Number(arg('--delay-ms', '400'));

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
  const name = `${o.last_name} ${o.first_name} 様`;
  const text = [
    name,
    '',
    'この度は Yellow Pearl（イエローパール）をご予約いただき、ありがとうございます。',
    '',
    'アクセスが集中した影響により、予約確認メールのお届けが遅れましたこと、深くお詫び申し上げます。',
    'お支払いおよびご予約は正常に完了しておりますので、ご安心ください。',
    '',
    '改めて、ご予約内容をご案内いたします。',
    '',
    `予約番号: ${o.order_id}`,
    `商品: ${PRODUCT}`,
    `数量: ${o.quantity} 本`,
    `合計金額: ${yen(o.total_amount)} 円（税込・送料込）`,
    '',
    '【お届け先】',
    address(o),
    `TEL: ${o.phone}`,
    '',
    SHIPPING,
    '',
    'ご不明点がございましたら、このメールにご返信ください。',
    '',
    '郷のきみイエローパール',
    'サポート担当　湯川',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>この度は Yellow Pearl（イエローパール）をご予約いただき、ありがとうございます。</p>
    <p>アクセスが集中した影響により、予約確認メールのお届けが遅れましたこと、深くお詫び申し上げます。<br>
    お支払いおよびご予約は正常に完了しておりますので、ご安心ください。</p>
    <p>改めて、ご予約内容をご案内いたします。</p>
    <ul>
      <li><strong>予約番号:</strong> ${o.order_id}</li>
      <li><strong>商品:</strong> ${PRODUCT}</li>
      <li><strong>数量:</strong> ${o.quantity} 本</li>
      <li><strong>合計金額:</strong> ${yen(o.total_amount)} 円（税込・送料込）</li>
    </ul>
    <p><strong>お届け先</strong><br>
    ${address(o)}<br>
    TEL: ${o.phone}</p>
    <p>${SHIPPING}</p>
    <p style="color:#666;font-size:12px">ご不明点がございましたら、このメールにご返信ください。</p>
    <p>郷のきみイエローパール<br>サポート担当　湯川</p>
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
  return block?.results ?? block?.result?.[0]?.results ?? [];
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
          'Content-Type': 'application/json',
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
    WHERE e.order_id = o.order_id AND e.event_type = 'confirmation_email_failed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM order_events e
    WHERE e.order_id = o.order_id
      AND e.event_type IN ('confirmation_email_sent', 'confirmation_email_resent')
  )
ORDER BY o.created_at ASC
LIMIT ${Number.isFinite(LIMIT) ? LIMIT : 1}
`.replace(/\s+/g, ' ').trim();

const token = oauthToken();
const rows = d1Json(sql);
console.log(JSON.stringify({ pending_fetched: rows.length, limit: LIMIT }));

let sent = 0;
let failed = 0;
for (const o of rows) {
  const { text, html } = bodies(o);
  const subject = `【Yellow Pearl】ご予約確認メール遅延のお詫び（${o.order_id}）`;
  const res = await api(
    'POST',
    `/client/v4/accounts/${ACCOUNT}/email/sending/send`,
    {
      to: o.email,
      from: FROM,
      reply_to: REPLY,
      subject,
      text,
      html,
    },
    token,
  );

  if (res.status >= 200 && res.status < 300 && res.json?.success !== false) {
    const escEmail = String(o.email).replace(/'/g, "''");
    d1Json(
      `INSERT INTO order_events (order_id, event_type, detail) VALUES ('${o.order_id}', 'confirmation_email_resent', 'delayed_apology:${escEmail}')`,
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
