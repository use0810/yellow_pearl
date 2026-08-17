/**
 * 銀行振込の口座案内メールを予約単位で送る。
 * 文面は Worker と同じ buildBankTransferBodies を使うので、本番送信と一致する。
 *
 * 文面の確認だけ:
 *   node --experimental-default-type=module scripts/send-bank-transfer-mail.mjs --order YP-XXXX --dry-run
 * 自分宛にテスト送信（送信記録は残さない）:
 *   node --experimental-default-type=module scripts/send-bank-transfer-mail.mjs --order YP-XXXX --to me@example.com
 * お客様本人に送信（送信記録を残す）:
 *   node --experimental-default-type=module scripts/send-bank-transfer-mail.mjs --order YP-XXXX --send
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
const TO_OVERRIDE = arg('--to');
const DRY_RUN = has('--dry-run');
const SEND_TO_CUSTOMER = has('--send');

if (!ORDER_ID) {
  console.error('--order YP-XXXX が必要です');
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

const rows = d1Json(
  `SELECT order_id, last_name, first_name, email, phone, postal, prefecture, address1, address2,
     quantity, total_amount, payment_status, status, bank_transfer_info, created_at
   FROM orders WHERE order_id = '${ORDER_ID.replace(/'/g, "''")}' AND archived_at IS NULL`,
);
const order = rows[0];
if (!order) {
  console.error(`予約が見つかりません: ${ORDER_ID}`);
  process.exit(1);
}

const info = parseBankTransferInfo(order);
if (!info) {
  console.error(
    `振込先が未保存です: ${ORDER_ID}\n`
    + '管理画面で「Stripe照合」を押して振込先を保存してから実行してください。',
  );
  process.exit(1);
}

const { text, html } = buildBankTransferBodies(order, info);
const subject = `【Yellow Pearl】お振込先のご案内（${order.order_id}）`;
const to = TO_OVERRIDE ?? order.email;

if (DRY_RUN) {
  console.log(`--- 宛先: ${to}`);
  console.log(`--- 件名: ${subject}`);
  console.log('---');
  console.log(text);
  process.exit(0);
}

const res = await api(
  'POST',
  `/client/v4/accounts/${ACCOUNT}/email/sending/send`,
  { to, from: FROM, reply_to: { address: REPLY_TO }, subject, text, html },
  oauthToken(),
);

const ok = res.status >= 200 && res.status < 300 && res.json?.success !== false;
if (!ok) {
  const msg = res.json?.errors?.[0]?.message || JSON.stringify(res.json);
  console.error(JSON.stringify({ ok: false, order_id: order.order_id, status: res.status, error: msg }));
  process.exit(1);
}

// テスト送信はお客様に届いていないので、送信済みの記録は残さない
if (!TO_OVERRIDE) {
  d1Json(
    `INSERT INTO order_events (order_id, event_type, detail)
     VALUES ('${order.order_id}', 'bank_transfer_email_sent', '${to.replace(/'/g, "''")}')`,
  );
}

console.log(JSON.stringify({ ok: true, order_id: order.order_id, to, logged: !TO_OVERRIDE }));
