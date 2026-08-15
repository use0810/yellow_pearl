import { PAYMENT_PAID, PRODUCT_NAME } from '../../../shared/domain.js';

const FROM_EMAIL = 'info@yellow-pearl.com';
const FROM_NAME = 'Yellow Pearl';
const SHIPPING_NOTE = '発送は2026年9月1日より順次行います。';

const ORDER_EMAIL_SELECT = `order_id, last_name, first_name, email, phone, postal, prefecture,
  address1, address2, quantity, total_amount, payment_status, status, created_at`;

async function logOrderEvent(db, orderId, eventType, detail = '') {
  await db.prepare(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES (?, ?, ?)`
  ).bind(orderId, eventType, detail).run();
}

async function hasOrderEvent(db, orderId, eventType) {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM order_events WHERE order_id = ? AND event_type = ? LIMIT 1`
  ).bind(orderId, eventType).first();
  return !!row?.ok;
}

function isEmailEnabled(env) {
  return env.EMAIL && typeof env.EMAIL.send === 'function';
}

function parseEmailList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 管理画面ログイン許可メール */
function adminLoginEmails(env) {
  return parseEmailList(env.ADMIN_ALLOWED_EMAILS);
}

/** 購入通知の宛先（未設定ならログイン許可の先頭にフォールバック） */
function adminNotifyEmails(env) {
  const notify = parseEmailList(env.ADMIN_NOTIFY_EMAILS);
  if (notify.length > 0) return notify;
  const login = adminLoginEmails(env);
  return login.length > 0 ? [login[0]] : [];
}

function replyToAddress(env) {
  return adminNotifyEmails(env)[0] || adminLoginEmails(env)[0] || FROM_EMAIL;
}

function formatAddress(order) {
  const line2 = order.address2 ? ` ${order.address2}` : '';
  return `〒${order.postal} ${order.prefecture}${order.address1}${line2}`;
}

function formatYen(n) {
  return Number(n ?? 0).toLocaleString('ja-JP');
}

async function fetchOrderForEmail(db, orderId) {
  return db.prepare(
    `SELECT ${ORDER_EMAIL_SELECT} FROM orders WHERE order_id = ? AND archived_at IS NULL`
  ).bind(orderId).first();
}

function buildConfirmationBodies(order) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const text = [
    `${name}`,
    '',
    'この度は Yellow Pearl（イエローパール）をご予約いただき、ありがとうございます。',
    'お支払いが完了しました。',
    '',
    `予約番号: ${order.order_id}`,
    `商品: ${PRODUCT_NAME}`,
    `数量: ${order.quantity} 本`,
    `合計金額: ${formatYen(order.total_amount)} 円（税込・送料込）`,
    '',
    '【お届け先】',
    formatAddress(order),
    `TEL: ${order.phone}`,
    '',
    SHIPPING_NOTE,
    '',
    'ご不明点がございましたら、このメールにご返信ください。',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>この度は Yellow Pearl（イエローパール）をご予約いただき、ありがとうございます。<br>
    お支払いが完了しました。</p>
    <ul>
      <li><strong>予約番号:</strong> ${order.order_id}</li>
      <li><strong>商品:</strong> ${PRODUCT_NAME}</li>
      <li><strong>数量:</strong> ${order.quantity} 本</li>
      <li><strong>合計金額:</strong> ${formatYen(order.total_amount)} 円（税込・送料込）</li>
    </ul>
    <p><strong>お届け先</strong><br>
    ${formatAddress(order)}<br>
    TEL: ${order.phone}</p>
    <p>${SHIPPING_NOTE}</p>
    <p style="color:#666;font-size:12px">ご不明点がございましたら、このメールにご返信ください。</p>
  `.trim();

  return { text, html };
}

function buildAdminPurchaseBodies(order) {
  const name = `${order.last_name} ${order.first_name}`;
  const text = [
    '【購入通知】Yellow Pearl に新しい決済がありました。',
    '',
    `予約番号: ${order.order_id}`,
    `お名前: ${name}`,
    `メール: ${order.email}`,
    `電話: ${order.phone}`,
    `数量: ${order.quantity} 本`,
    `合計: ${formatYen(order.total_amount)} 円（税込・送料込）`,
    '',
    '【お届け先】',
    formatAddress(order),
    '',
    '管理画面の予約一覧で詳細を確認できます。',
  ].join('\n');

  const html = `
    <p><strong>【購入通知】</strong>Yellow Pearl に新しい決済がありました。</p>
    <ul>
      <li><strong>予約番号:</strong> ${order.order_id}</li>
      <li><strong>お名前:</strong> ${name}</li>
      <li><strong>メール:</strong> ${order.email}</li>
      <li><strong>電話:</strong> ${order.phone}</li>
      <li><strong>数量:</strong> ${order.quantity} 本</li>
      <li><strong>合計:</strong> ${formatYen(order.total_amount)} 円（税込・送料込）</li>
    </ul>
    <p><strong>お届け先</strong><br>
    ${formatAddress(order)}</p>
    <p style="color:#666;font-size:12px">管理画面の予約一覧で詳細を確認できます。</p>
  `.trim();

  return { text, html };
}

/** 運営向け購入通知（冪等・ADMIN_NOTIFY_EMAILS 宛） */
async function maybeSendAdminPurchaseNotification(env, order) {
  const recipients = adminNotifyEmails(env);
  if (recipients.length === 0) return { skipped: true, reason: 'no_admin' };
  if (await hasOrderEvent(env.DB, order.order_id, 'admin_purchase_email_sent')) {
    return { skipped: true, reason: 'already_sent' };
  }

  const { text, html } = buildAdminPurchaseBodies(order);
  const subject = `【購入】${order.quantity}本・${formatYen(order.total_amount)}円（${order.order_id}）`;
  try {
    for (const to of recipients) {
      await env.EMAIL.send({
        to,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        text,
        html,
      });
    }
    await logOrderEvent(env.DB, order.order_id, 'admin_purchase_email_sent', recipients.join(','));
    return { ok: true };
  } catch (e) {
    await logOrderEvent(env.DB, order.order_id, 'admin_purchase_email_failed', e.message || 'send failed');
    return { error: e.message || '運営通知メールの送信に失敗しました' };
  }
}

function buildCancellationBodies(order, { refunded = false } = {}) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const refundLine = refunded
    ? '決済済みのご予約のため、返金処理を行いました。カード会社により反映まで数日かかる場合があります。'
    : '未決済のご予約のため、決済は発生していません。';

  const text = [
    `${name}`,
    '',
    '以下のご予約をキャンセルしました。',
    '',
    `予約番号: ${order.order_id}`,
    refundLine,
    '',
    'ご不明点がございましたら、このメールにご返信ください。',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>以下のご予約をキャンセルしました。</p>
    <p><strong>予約番号:</strong> ${order.order_id}</p>
    <p>${refundLine}</p>
    <p style="color:#666;font-size:12px">ご不明点がございましたら、このメールにご返信ください。</p>
  `.trim();

  return { text, html };
}

/** 管理画面からの確認メール再送（冪等チェックなし・再送ごとに order_events に記録） */
export async function resendConfirmationEmail(env, orderId) {
  if (!isEmailEnabled(env)) {
    return { error: 'メール送信が設定されていません', status: 503 };
  }

  const order = await fetchOrderForEmail(env.DB, orderId);
  if (!order) return { error: '予約が見つかりません', status: 404 };
  if (order.payment_status !== PAYMENT_PAID) {
    return { error: '決済済みの予約のみ確認メールを送信できます', status: 400 };
  }

  const { text, html } = buildConfirmationBodies(order);
  try {
    await env.EMAIL.send({
      to: order.email,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      replyTo: replyToAddress(env),
      subject: `【Yellow Pearl】ご予約ありがとうございます（${order.order_id}）`,
      text,
      html,
    });
    await logOrderEvent(env.DB, orderId, 'confirmation_email_resent', order.email);
    return { ok: true };
  } catch (e) {
    await logOrderEvent(env.DB, orderId, 'confirmation_email_resend_failed', e.message || 'send failed');
    return { error: e.message || 'メール送信に失敗しました', status: 502 };
  }
}

/** 決済確定後の予約確認メール（Webhook / 返却 URL 共通・冪等）＋運営通知 */
export async function maybeSendConfirmationEmail(env, orderId) {
  if (!isEmailEnabled(env)) return { skipped: true, reason: 'no_binding' };

  const order = await fetchOrderForEmail(env.DB, orderId);
  if (!order || order.payment_status !== PAYMENT_PAID) {
    return { skipped: true, reason: 'not_paid' };
  }

  let customerResult = { skipped: true, reason: 'already_sent' };
  if (!(await hasOrderEvent(env.DB, orderId, 'confirmation_email_sent'))) {
    const { text, html } = buildConfirmationBodies(order);
    try {
      await env.EMAIL.send({
        to: order.email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: replyToAddress(env),
        subject: `【Yellow Pearl】ご予約ありがとうございます（${order.order_id}）`,
        text,
        html,
      });
      await logOrderEvent(env.DB, orderId, 'confirmation_email_sent', order.email);
      customerResult = { ok: true };
    } catch (e) {
      await logOrderEvent(env.DB, orderId, 'confirmation_email_failed', e.message || 'send failed');
      customerResult = { error: e.message || 'メール送信に失敗しました' };
    }
  }

  // お客さまメールの成否に関わらず、運営通知は別途冪等で送る
  await maybeSendAdminPurchaseNotification(env, order);
  if (customerResult.error) return customerResult;
  return { ok: true };
}

/** 管理画面キャンセル後の通知メール（冪等） */
export async function maybeSendCancellationEmail(env, orderId, { refunded = false } = {}) {
  if (!isEmailEnabled(env)) return { skipped: true, reason: 'no_binding' };

  if (await hasOrderEvent(env.DB, orderId, 'cancellation_email_sent')) {
    return { skipped: true, reason: 'already_sent' };
  }

  const order = await fetchOrderForEmail(env.DB, orderId);
  if (!order) return { skipped: true, reason: 'not_found' };

  const { text, html } = buildCancellationBodies(order, { refunded });
  try {
    await env.EMAIL.send({
      to: order.email,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      replyTo: replyToAddress(env),
      subject: `【Yellow Pearl】ご予約のキャンセル（${order.order_id}）`,
      text,
      html,
    });
    await logOrderEvent(env.DB, orderId, 'cancellation_email_sent', refunded ? 'refunded' : 'cancelled');
    return { ok: true };
  } catch (e) {
    await logOrderEvent(env.DB, orderId, 'cancellation_email_failed', e.message || 'send failed');
    return { error: e.message || 'メール送信に失敗しました' };
  }
}
