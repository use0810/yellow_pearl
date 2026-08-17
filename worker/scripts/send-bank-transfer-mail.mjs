/**
 * 銀行振込の口座案内メールを送る。文面は Worker と同じ buildBankTransferBodies を
 * 使うので、自動送信される内容と一致する。
 *
 * 対象の指定:
 *   --order YP-XXXX   予約1件
 *   --all             振込先が保存済みで、まだ案内を送っていない振込待ち全件
 *   --limit N         --all の件数上限（既定 500）
 *
 * 動作の指定:
 *   --dry-run         送らずに宛先と文面を表示
 *   --to <addr>       指定アドレスにテスト送信（送信済みの記録は残さない）
 *   --send            お客様本人に送信（送信済みの記録を残す）
 *
 * 例:
 *   node --experimental-default-type=module scripts/send-bank-transfer-mail.mjs --all --limit 5 --to me@example.com
 *   node --experimental-default-type=module scripts/send-bank-transfer-mail.mjs --all --send
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildBankTransferBodies } from '../src/lib/email.js';
import { parseBankTransferInfo } from '../../shared/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.join(__dirname, '..');
const ACCOUNT = 'e1b3f72b4806b9ee6db348e090df9590';
const FROM = { address: 'info@yellow-pearl.com', name: 'Yellow Pearl' };
// Worker 側の replyToAddress（ADMIN_NOTIFY_EMAILS の先頭）と揃える
const REPLY_TO = 'shingo.satokimi2021@gmail.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const has = (name) => process.argv.includes(name);

const ORDER_ID = arg('--order');
const ALL = has('--all');
const LIMIT = Number(arg('--limit', '500'));
const TO_OVERRIDE = arg('--to');
const DRY_RUN = has('--dry-run');
const SEND_TO_CUSTOMER = has('--send');
const DELAY_MS = Number(arg('--delay-ms', '400'));

if (!ORDER_ID && !ALL) {
  console.error('--order YP-XXXX か --all を指定してください');
  process.exit(1);
}
if (!DRY_RUN && !TO_OVERRIDE && !SEND_TO_CUSTOMER) {
  console.error('--dry-run / --to <addr> / --send のいずれかを指定してください');
  process.exit(1);
}

function oauthToken() {
  const p = path.join(
    process.env.USERPROFILE || process.env.HOME,
    'AppData/Roaming/xdg.config/.wrangler/config/default.toml',
  );
  const m = fs.readFileSync(p, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('oauth_token not found');
  return m[1];
}

function d1Json(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'yellow-pearl-db', '--remote', '--json', '--command', oneLine],
    { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SELECT = `order_id, last_name, first_name, email, phone, postal, prefecture, address1,
  address2, quantity, total_amount, payment_status, status, bank_transfer_info, created_at`;

function fetchOrders() {
  if (ORDER_ID) {
    return d1Json(
      `SELECT ${SELECT} FROM orders
       WHERE order_id = '${ORDER_ID.replace(/'/g, "''")}' AND archived_at IS NULL`,
    );
  }
  // 期限が近い順に送る。既に案内済みの予約は除く
  return d1Json(
    `SELECT ${SELECT} FROM orders o
     WHERE o.archived_at IS NULL
       AND o.payment_status = '未決済'
       AND o.status = '予約'
       AND o.bank_transfer_info IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM order_events e
         WHERE e.order_id = o.order_id AND e.event_type = 'bank_transfer_email_sent'
       )
     ORDER BY o.created_at ASC
     LIMIT ${Number.isFinite(LIMIT) ? LIMIT : 500}`,
  );
}

const orders = fetchOrders();
if (orders.length === 0) {
  console.log(JSON.stringify({ done: true, target: 0, note: '対象の予約がありません' }));
  process.exit(0);
}

console.log(JSON.stringify({
  target: orders.length,
  mode: DRY_RUN ? 'dry-run' : (TO_OVERRIDE ? `test:${TO_OVERRIDE}` : 'send-to-customer'),
}));

const token = DRY_RUN ? null : oauthToken();
let sent = 0;
let failed = 0;
let skipped = 0;

for (const order of orders) {
  const info = parseBankTransferInfo(order);
  if (!info) {
    skipped += 1;
    console.log(JSON.stringify({ skipped: order.order_id, reason: '振込先が未保存' }));
    continue;
  }

  const { text, html } = buildBankTransferBodies(order, info);
  const subject = `【Yellow Pearl】お振込先のご案内（${order.order_id}）`;
  const to = TO_OVERRIDE ?? order.email;

  if (DRY_RUN) {
    console.log(`\n=== ${order.order_id} / ${order.last_name} ${order.first_name} → ${to}`);
    console.log(`件名: ${subject}`);
    console.log(text);
    continue;
  }

  const res = await api(
    'POST',
    `/client/v4/accounts/${ACCOUNT}/email/sending/send`,
    { to, from: FROM, reply_to: { address: REPLY_TO }, subject, text, html },
    token,
  );

  const ok = res.status >= 200 && res.status < 300 && res.json?.success !== false;
  if (!ok) {
    failed += 1;
    const msg = res.json?.errors?.[0]?.message || JSON.stringify(res.json);
    console.log(JSON.stringify({ ok: false, order_id: order.order_id, status: res.status, error: msg }));
    if (/quota|throttl|daily|rate.?limit/i.test(String(msg))) {
      console.log(JSON.stringify({ stopped: 'quota' }));
      break;
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
    continue;
  }

  // テスト送信はお客様に届いていないので、送信済みの記録は残さない
  if (!TO_OVERRIDE) {
    d1Json(
      `INSERT INTO order_events (order_id, event_type, detail)
       VALUES ('${order.order_id}', 'bank_transfer_email_sent', '${to.replace(/'/g, "''")}')`,
    );
  }
  sent += 1;
  console.log(JSON.stringify({
    ok: true, order_id: order.order_id, name: `${order.last_name}${order.first_name}`, to,
  }));
  if (DELAY_MS > 0) await sleep(DELAY_MS);
}

if (!DRY_RUN) {
  console.log(JSON.stringify({ done: true, sent, failed, skipped, logged: !TO_OVERRIDE }));
}
