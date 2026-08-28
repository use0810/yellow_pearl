import {
  bankTransferLines,
  parseBankTransferInfo,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PRODUCT_NAME,
} from '../../../shared/domain.js';

const FROM_EMAIL = 'info@yellow-pearl.com';
const FROM_NAME = 'Yellow Pearl';
const SHIPPING_NOTE = '発送は2026年9月1日より順次行います。';

const ORDER_EMAIL_SELECT = `order_id, last_name, first_name, email, phone, postal, prefecture,
  address1, address2, quantity, total_amount, payment_status, status, bank_transfer_info, created_at`;

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
    `この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。`,
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
    <p>この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。<br>
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

/** アクセス集中による確認メール遅延のお詫び＋予約内容（一括再送用） */
function buildDelayedConfirmationBodies(order) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const text = [
    `${name}`,
    '',
    `この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。`,
    '',
    'アクセスが集中した影響により、予約確認メールのお届けが遅れましたこと、深くお詫び申し上げます。',
    'お支払いおよびご予約は正常に完了しておりますので、ご安心ください。',
    '',
    '改めて、ご予約内容をご案内いたします。',
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
    '',
    '郷のきみイエローパール',
    'サポート担当　湯川',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。</p>
    <p>アクセスが集中した影響により、予約確認メールのお届けが遅れましたこと、深くお詫び申し上げます。<br>
    お支払いおよびご予約は正常に完了しておりますので、ご安心ください。</p>
    <p>改めて、ご予約内容をご案内いたします。</p>
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
    <p>郷のきみイエローパール<br>サポート担当　湯川</p>
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

/** 振込待ちの上限は予約日から14日（cleanupStaleOrders と揃える） */
const BANK_TRANSFER_DEADLINE_DAYS = 14;

/** 予約日から数えた振込期限を「YYYY年M月D日」で返す */
function bankTransferDeadline(createdAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt || '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + BANK_TRANSFER_DEADLINE_DAYS);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function buildBankTransferBodies(order, info) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const amount = `${formatYen(order.total_amount)} 円`;
  const lines = bankTransferLines(info);
  const deadline = bankTransferDeadline(order.created_at);
  const deadlineText = deadline
    ? `お振込の期限は ${deadline} です。`
    : `お振込の期限はご予約から${BANK_TRANSFER_DEADLINE_DAYS}日間です。`;

  const text = [
    name,
    '',
    `この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。`,
    'お振込先をご案内いたします。下記口座へお振込いただき次第、ご予約が確定します。',
    '',
    `予約番号: ${order.order_id}`,
    `商品: ${PRODUCT_NAME}`,
    `数量: ${order.quantity} 本`,
    `お振込金額: ${amount}（税込・送料込）`,
    '',
    '【お振込先】',
    ...lines.map(([label, value]) => `${label}: ${value}`),
    '',
    'この口座はお客様のご予約専用です。他のご予約分と合わせてのお振込はお受けできません。',
    '複数ご予約いただいている場合は、ご予約ごとに別々にお振込をお願いいたします。',
    '',
    `${deadlineText}期限を過ぎますとご予約は自動的にキャンセルとなります。`,
    '振込手数料はお客様のご負担となります。あらかじめご了承ください。',
    '',
    '【お届け先】',
    formatAddress(order),
    `TEL: ${order.phone}`,
    '',
    SHIPPING_NOTE,
    '',
    'ご不明点がございましたら、このメールにご返信ください。',
    '',
    '郷のきみイエローパール',
    'サポート担当　湯川',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>この度は${PRODUCT_NAME}をご予約いただき、ありがとうございます。<br>
    お振込先をご案内いたします。下記口座へお振込いただき次第、ご予約が確定します。</p>
    <ul>
      <li><strong>予約番号:</strong> ${order.order_id}</li>
      <li><strong>商品:</strong> ${PRODUCT_NAME}</li>
      <li><strong>数量:</strong> ${order.quantity} 本</li>
      <li><strong>お振込金額:</strong> ${amount}（税込・送料込）</li>
    </ul>
    <p><strong>お振込先</strong><br>
    ${lines.map(([label, value]) => `${label}: ${value}`).join('<br>')}</p>
    <p><strong>この口座はお客様のご予約専用です。</strong>他のご予約分と合わせてのお振込はお受けできません。
    複数ご予約いただいている場合は、ご予約ごとに別々にお振込をお願いいたします。</p>
    <p><strong>${deadlineText}</strong>期限を過ぎますとご予約は自動的にキャンセルとなります。<br>
    振込手数料はお客様のご負担となります。あらかじめご了承ください。</p>
    <p><strong>お届け先</strong><br>
    ${formatAddress(order)}<br>
    TEL: ${order.phone}</p>
    <p>${SHIPPING_NOTE}</p>
    <p style="color:#666;font-size:12px">ご不明点がございましたら、このメールにご返信ください。</p>
    <p>郷のきみイエローパール<br>サポート担当　湯川</p>
  `.trim();

  return { text, html };
}

/** 銀行振込の口座案内（冪等）。振込先が保存済みの予約のみ対象 */
export async function maybeSendBankTransferEmail(env, orderId) {
  if (!isEmailEnabled(env)) return { skipped: true, reason: 'no_binding' };
  if (await hasOrderEvent(env.DB, orderId, 'bank_transfer_email_sent')) {
    return { skipped: true, reason: 'already_sent' };
  }

  const order = await fetchOrderForEmail(env.DB, orderId);
  const info = parseBankTransferInfo(order);
  if (!order || !info) return { skipped: true, reason: 'no_instructions' };

  const { text, html } = buildBankTransferBodies(order, info);
  try {
    await env.EMAIL.send({
      to: order.email,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      replyTo: replyToAddress(env),
      subject: `【Yellow Pearl】お振込先のご案内（${order.order_id}）`,
      text,
      html,
    });
    await logOrderEvent(env.DB, orderId, 'bank_transfer_email_sent', order.email);
    return { ok: true };
  } catch (e) {
    await logOrderEvent(env.DB, orderId, 'bank_transfer_email_failed', e.message || 'send failed');
    return { error: e.message || 'メール送信に失敗しました' };
  }
}

const REORDER_URL = 'https://yellow-pearl.com/cart.html';
const RULE_LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SIGN_LINE = '--------------------------------------------------';

/** 振込期限の経過で自動キャンセルになったことのお知らせ */
export function buildBankTransferExpiredBodies(order) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const amount = `${formatYen(order.total_amount)}円（税込・送料込）`;
  const deadline = bankTransferDeadline(order.created_at);
  const deadlineLine = deadline
    ? `ご案内しておりましたお振込期限（${deadline}）までに、`
    : 'ご案内しておりましたお振込期限までに、';

  const text = [
    name,
    '',
    'いつも「郷のきみイエローパール」をご愛顧いただき、誠にありがとうございます。',
    '',
    'この度は、「新郷村プレミアムライン 郷のきみイエローパール」をご予約いただき、',
    '重ねて御礼申し上げます。',
    '',
    deadlineLine,
    'ご入金の確認が叶いませんでしたため、',
    '誠に勝手ながら下記のご注文につきましては',
    'キャンセル処理をさせていただきました。',
    '',
    RULE_LINE,
    '■ ご予約内容',
    `・予約番号：${order.order_id}`,
    `・ご注文商品：${PRODUCT_NAME}`,
    `・数量：${order.quantity}本`,
    `・お支払い金額：${amount}`,
    RULE_LINE,
    '',
    '本案内に伴い、事前にお伝えしておりましたお振込口座は無効となります。',
    'これ以降のお振込みは不要でございます。',
    '',
    '※本メールと行き違いでお振込みいただいた場合は、',
    '大変お手数ですが本メールへご返信いただけますでしょうか。',
    '確認のうえ、速やかに対応させていただきます。',
    '',
    'なお、改めてご購入をご希望の場合は、下記ページより再度お申し込みいただけます。',
    '（季節商品の性質上、在庫がなくなり次第受付終了となりますのであらかじめご了承ください）',
    '',
    '▼ 再申し込みページ',
    REORDER_URL,
    '',
    'またのご利用を、スタッフ一同心よりお待ち申し上げております。',
    '',
    SIGN_LINE,
    '郷のきみイエローパール',
    SIGN_LINE,
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>いつも「郷のきみイエローパール」をご愛顧いただき、誠にありがとうございます。</p>
    <p>この度は、「新郷村プレミアムライン 郷のきみイエローパール」をご予約いただき、<br>
    重ねて御礼申し上げます。</p>
    <p>${deadlineLine}<br>
    ご入金の確認が叶いませんでしたため、<br>
    誠に勝手ながら下記のご注文につきましては<br>
    キャンセル処理をさせていただきました。</p>
    <div style="border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:12px 0;margin:16px 0">
      <p style="margin:0 0 8px;font-weight:bold">ご予約内容</p>
      <ul style="margin:0;padding-left:1.2em">
        <li>予約番号：${order.order_id}</li>
        <li>ご注文商品：${PRODUCT_NAME}</li>
        <li>数量：${order.quantity}本</li>
        <li>お支払い金額：${amount}</li>
      </ul>
    </div>
    <p>本案内に伴い、事前にお伝えしておりましたお振込口座は無効となります。<br>
    これ以降のお振込みは不要でございます。</p>
    <p>※本メールと行き違いでお振込みいただいた場合は、<br>
    大変お手数ですが本メールへご返信いただけますでしょうか。<br>
    確認のうえ、速やかに対応させていただきます。</p>
    <p>なお、改めてご購入をご希望の場合は、下記ページより再度お申し込みいただけます。<br>
    （季節商品の性質上、在庫がなくなり次第受付終了となりますのであらかじめご了承ください）</p>
    <p>▼ 再申し込みページ<br>
    <a href="${REORDER_URL}">${REORDER_URL}</a></p>
    <p>またのご利用を、スタッフ一同心よりお待ち申し上げております。</p>
    <hr style="border:none;border-top:1px solid #ddd">
    <p>郷のきみイエローパール</p>
  `.trim();

  return { text, html };
}

export function bankTransferExpiredSubject(order) {
  return `【重要】【郷のきみイエローパール】ご予約キャンセルのご案内（予約番号：${order.order_id}）`;
}

/** 振込期限切れの案内（冪等）。振込先を発行済みで、期限超過でキャンセルになった予約のみ対象 */
export async function maybeSendBankTransferExpiredEmail(env, orderId) {
  if (!isEmailEnabled(env)) return { skipped: true, reason: 'no_binding' };
  if (await hasOrderEvent(env.DB, orderId, 'bank_transfer_expired_email_sent')) {
    return { skipped: true, reason: 'already_sent' };
  }

  const order = await fetchOrderForEmail(env.DB, orderId);
  if (!order || order.payment_status !== PAYMENT_FAILED) {
    return { skipped: true, reason: 'not_expired' };
  }
  // 振込先を見ていないお客様に「お振込は不要」と送っても混乱するだけなので対象外
  if (!parseBankTransferInfo(order)) return { skipped: true, reason: 'no_instructions' };

  const { text, html } = buildBankTransferExpiredBodies(order);
  try {
    await env.EMAIL.send({
      to: order.email,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      replyTo: replyToAddress(env),
      subject: bankTransferExpiredSubject(order),
      text,
      html,
    });
    await logOrderEvent(env.DB, orderId, 'bank_transfer_expired_email_sent', order.email);
    return { ok: true };
  } catch (e) {
    await logOrderEvent(env.DB, orderId, 'bank_transfer_expired_email_failed', e.message || 'send failed');
    return { error: e.message || 'メール送信に失敗しました' };
  }
}

/**
 * 深夜の掃除で振込期限切れになった予約へ、日中の cron から案内を送る。
 * 在庫の解放は掃除側で即座に行い、お客様への連絡だけを日中に回す。
 */
export async function sendPendingBankTransferExpiredEmails(env, { limit = 100 } = {}) {
  if (!isEmailEnabled(env)) return { skipped: true, reason: 'no_binding' };

  const rows = await env.DB.prepare(
    `SELECT o.order_id AS order_id
     FROM orders o
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
     LIMIT ?`
  ).bind(limit).all();

  let sent = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    const result = await maybeSendBankTransferExpiredEmail(env, row.order_id);
    if (result.ok) sent += 1;
    else if (result.error) failed += 1;
  }
  return { sent, failed, target: (rows.results ?? []).length };
}

function buildCancellationBodies(order, { refunded = false } = {}) {
  const name = `${order.last_name} ${order.first_name} 様`;
  const refundLine = refunded
    ? '決済済みのご予約のため、返金処理を行いました。カード会社により反映まで数日かかる場合があります。'
    : '未決済のご予約のため、決済は発生していません。';
  // キャンセル時に Stripe のセッションを失効させるため、発行済みの専用口座は使えなくなる
  const bankLines = !refunded && parseBankTransferInfo(order)
    ? [
      'ご案内しておりましたお振込先は無効となりました。お振込は不要です。',
      '行き違いでお振込みいただいていた場合は、このメールにご返信ください。',
    ]
    : [];

  const text = [
    `${name}`,
    '',
    '以下のご予約をキャンセルしました。',
    '',
    `予約番号: ${order.order_id}`,
    refundLine,
    ...(bankLines.length ? ['', ...bankLines] : []),
    '',
    'ご不明点がございましたら、このメールにご返信ください。',
  ].join('\n');

  const html = `
    <p>${name}</p>
    <p>以下のご予約をキャンセルしました。</p>
    <p><strong>予約番号:</strong> ${order.order_id}</p>
    <p>${refundLine}</p>
    ${bankLines.length ? `<p>${bankLines.join('<br>')}</p>` : ''}
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

/**
 * 送信失敗のまま成功記録がない決済済予約へ、遅延お詫び付き確認メールを再送する。
 * 日次クォータ回復後の cron 向け。運営通知・お客様からの返信対応は対象外。
 */
export async function retryFailedConfirmationEmails(env, { limit = 200 } = {}) {
  if (!isEmailEnabled(env)) {
    return { skipped: true, reason: 'no_binding' };
  }

  const rows = await env.DB.prepare(
    `SELECT o.order_id AS order_id
     FROM orders o
     WHERE o.payment_status = ?
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
     LIMIT ?`
  ).bind(PAYMENT_PAID, limit).all();

  const orderIds = (rows.results ?? []).map((r) => r.order_id);
  let sent = 0;
  let failed = 0;
  for (const orderId of orderIds) {
    const order = await fetchOrderForEmail(env.DB, orderId);
    if (!order || order.payment_status !== PAYMENT_PAID) {
      failed += 1;
      continue;
    }
    const { text, html } = buildDelayedConfirmationBodies(order);
    try {
      await env.EMAIL.send({
        to: order.email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: replyToAddress(env),
        subject: `【Yellow Pearl】ご予約確認メール遅延のお詫び（${order.order_id}）`,
        text,
        html,
      });
      await logOrderEvent(env.DB, orderId, 'confirmation_email_resent', `delayed_apology:${order.email}`);
      sent += 1;
    } catch (e) {
      const msg = e.message || 'send failed';
      await logOrderEvent(env.DB, orderId, 'confirmation_email_resend_failed', msg);
      failed += 1;
      if (/quota|daily|rate.?limit|throttl/i.test(msg)) {
        break;
      }
    }
  }

  return { ok: true, attempted: orderIds.length, sent, failed };
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
