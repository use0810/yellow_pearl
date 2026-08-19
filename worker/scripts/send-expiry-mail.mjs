/**
 * 振込期限切れのキャンセル案内メールを送る。文面は Worker と同じ
 * buildBankTransferExpiredBodies を使うので、cron で自動送信される内容と一致する。
 *
 * 通常は 09:20 JST の cron が送るので、このスクリプトはテスト送信と
 * 取りこぼしの手当てに使う。
 *
 * 対象の指定:
 *   --order YP-XXXX   予約1件（状態を問わずプレビューできる）
 *   --all             期限切れでキャンセル済みかつ未送信の全件
 *   --limit N         --all の件数上限（既定 100）
 *
 * 動作の指定:
 *   --dry-run         送らずに宛先と文面を表示
 *   --to <addr>       指定アドレスにテスト送信（送信済みの記録は残さない）
 *   --send            お客様本人に送信（送信済みの記録を残す）
 *
 * 例:
 *   node --experimental-default-type=module scripts/send-expiry-mail.mjs --order YP-XXXX --dry-run
 *   node --experimental-default-type=module scripts/send-expiry-mail.mjs --order YP-XXXX --to me@example.com
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { bankTransferExpiredSubject, buildBankTransferExpiredBodies } from '../src/lib/email.js';
import { parseBankTransferInfo } from '../../shared/domain.js';

const ACCOUNT = 'e1b3f72b4806b9ee6db348e090df9590';
const DATABASE_ID = '83ca742c-5668-4f55-8385-9de1a6d027e1';
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
const LIMIT = Number(arg('--limit', '100'));
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

const token = oauthToken();

/** wrangler を挟まず D1 の REST API を直接叩く（npx のバージョン差で認証が揺れるため） */
async function d1Query(sql, params = []) {
  const res = await api(
    'POST',
    `/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE_ID}/query`,
    { sql: sql.replace(/\s+/g, ' ').trim(), params },
    token,
  );
  const ok = res.status >= 200 && res.status < 300 && res.json?.success !== false;
  if (!ok) {
    throw new Error(`D1 query failed: ${JSON.stringify(res.json?.errors ?? res.json)}`);
  }
  const block = Array.isArray(res.json?.result) ? res.json.result[0] : res.json?.result;
  return block?.results ?? [];
}

const SELECT = `order_id, last_name, first_name, email, phone, postal, prefecture, address1,
  address2, quantity, total_amount, payment_status, status, bank_transfer_info, created_at`;

function fetchOrders() {
  if (ORDER_ID) {
    return d1Query(
      `SELECT ${SELECT} FROM orders WHERE order_id = ? AND archived_at IS NULL`,
      [ORDER_ID],
    );
  }
  return d1Query(
    `SELECT ${SELECT} FROM orders o
     WHERE o.archived_at IS NULL
       AND o.bank_transfer_info IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM order_events e
         WHERE e.order_id = o.order_id AND e.event_type = 'payment_failed_cleanup_limit'
       )
       AND NOT EXISTS (
         SELECT 1 FROM order_events e
         WHERE e.order_id = o.order_id AND e.event_type = 'bank_transfer_expired_email_sent'
       )
     ORDER BY o.created_at ASC
     LIMIT ?`,
    [Number.isFinite(LIMIT) ? LIMIT : 100],
  );
}

const orders = await fetchOrders();
if (orders.length === 0) {
  console.log(JSON.stringify({ done: true, target: 0, note: '対象の予約がありません' }));
  process.exit(0);
}

console.log(JSON.stringify({
  target: orders.length,
  mode: DRY_RUN ? 'dry-run' : (TO_OVERRIDE ? `test:${TO_OVERRIDE}` : 'send-to-customer'),
}));

let sent = 0;
let failed = 0;
let skipped = 0;

for (const order of orders) {
  if (!parseBankTransferInfo(order)) {
    skipped += 1;
    console.log(JSON.stringify({ skipped: order.order_id, reason: '振込先が未保存' }));
    continue;
  }

  const { text, html } = buildBankTransferExpiredBodies(order);
  const subject = bankTransferExpiredSubject(order);
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
    await d1Query(
      `INSERT INTO order_events (order_id, event_type, detail)
       VALUES (?, 'bank_transfer_expired_email_sent', ?)`,
      [order.order_id, to],
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
