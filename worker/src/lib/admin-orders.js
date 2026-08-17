import {
  BOOKKEEPING_ORDER_FILTER,
  MAX_LEN,
  ORDER_STATUSES,
  ORDER_STATUS_CANCELLED,
  ORDER_STATUS_DONE,
  ORDER_STATUS_RESERVED,
  ORDER_NOT_ARCHIVED,
  PAYMENT_CANCELLED,
  PAYMENT_FAILED,
  PAYMENT_PAID,
  PAYMENT_REFUNDED,
  PAYMENT_UNPAID,
  PREFECTURES,
  orderHoldsStock,
  cancelReasonLabel,
  getShippingRegionsFromMap,
  parseBankTransferInfo,
  validateOrderContactFields,
} from '../../../shared/domain.js';
import { json } from './http.js';
import {
  decrementStock,
  fetchInventoryRow,
  getShippingMap,
  incrementStock,
  inventoryPublicFields,
  inventoryStripeMode,
  markBankTransferPending,
  markOrderFailedAndReleaseStock,
} from './inventory.js';
import {
  expireStripeCheckoutSession,
  isStripeEnabledForMode,
  refundStripePayment,
  resolveStripeMode,
  stripeFetch,
  stripeModeFromResourceId,
} from './stripe.js';
import { maybeSendCancellationEmail, resendConfirmationEmail } from './email.js';

const ORDER_SELECT = `order_id, last_name, first_name, last_name_kana, first_name_kana,
  email, phone, postal, prefecture, address1, address2, note,
  quantity, unit_price, shipping_fee, tax_amount, total_amount,
  status, payment_status, admin_note, stripe_session_id, stripe_payment_id,
  bank_transfer_info, created_at`;

const CONTACT_KEYS = [
  'last_name', 'first_name', 'last_name_kana', 'first_name_kana',
  'email', 'phone', 'postal', 'prefecture', 'address1', 'address2',
];

async function logOrderEvent(db, orderId, eventType, detail = '') {
  await db.prepare(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES (?, ?, ?)`
  ).bind(orderId, eventType, detail).run();
}

async function updateOrderContact(db, orderId, contact, previous) {
  await db.prepare(
    `UPDATE orders SET
      last_name = ?, first_name = ?, last_name_kana = ?, first_name_kana = ?,
      email = ?, phone = ?, postal = ?, prefecture = ?, address1 = ?, address2 = ?
     WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(
    contact.last_name,
    contact.first_name,
    contact.last_name_kana,
    contact.first_name_kana,
    contact.email,
    contact.phone,
    contact.postal,
    contact.prefecture,
    contact.address1,
    contact.address2,
    orderId,
  ).run();

  const changed = CONTACT_KEYS.filter((k) => String(previous?.[k] ?? '') !== String(contact[k] ?? ''));
  if (changed.length > 0) {
    await logOrderEvent(db, orderId, 'contact_updated', changed.join(','));
  }
}

export async function handleAdminDashboard(env, CORS) {
  const inv = await fetchInventoryRow(env.DB);

  const sold = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS sold FROM orders WHERE ${BOOKKEEPING_ORDER_FILTER}`
  ).first() ?? { sold: 0 };
  const orderCount = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM orders WHERE ${BOOKKEEPING_ORDER_FILTER}`
  ).first() ?? { cnt: 0 };

  const shippingMap = await getShippingMap(env.DB);

  return json({
    inventory: inventoryPublicFields(inv, env),
    shipping_regions: getShippingRegionsFromMap(shippingMap),
    sold: sold?.sold ?? 0,
    order_count: orderCount?.cnt ?? 0,
  }, 200, CORS);
}

function likePattern(raw) {
  const cleaned = String(raw || '')
    .trim()
    .slice(0, 40)
    .replace(/[%_\\]/g, '');
  return cleaned ? `%${cleaned}%` : '';
}

function normalizeOrdersFilter(raw) {
  if (raw === 'cancelled' || raw === 'shipped' || raw === 'pending' || raw === 'bank_pending') {
    return raw;
  }
  return 'pending';
}

function buildOrdersListQuery(url) {
  const filter = normalizeOrdersFilter(url.searchParams.get('filter') || 'pending');
  const nameLike = likePattern(url.searchParams.get('name') || '');
  const prefectureRaw = (url.searchParams.get('prefecture') || '').trim();
  const prefecture = PREFECTURES.includes(prefectureRaw) ? prefectureRaw : '';

  let where;
  if (filter === 'cancelled') {
    where = `status = '${ORDER_STATUS_CANCELLED}' AND ${ORDER_NOT_ARCHIVED}`;
  } else if (filter === 'shipped') {
    where = `status = '${ORDER_STATUS_DONE}' AND ${ORDER_NOT_ARCHIVED}`;
  } else if (filter === 'bank_pending') {
    where = `status = '${ORDER_STATUS_RESERVED}'
      AND payment_status = '${PAYMENT_UNPAID}'
      AND ${ORDER_NOT_ARCHIVED}`;
  } else {
    where = `status = '${ORDER_STATUS_RESERVED}' AND ${ORDER_NOT_ARCHIVED}`;
  }

  const binds = [];
  if (nameLike) {
    where += ` AND (
      last_name LIKE ? OR first_name LIKE ?
      OR last_name_kana LIKE ? OR first_name_kana LIKE ?
      OR (last_name || first_name) LIKE ?
      OR (last_name || ' ' || first_name) LIKE ?
      OR order_id LIKE ?
    )`;
    binds.push(nameLike, nameLike, nameLike, nameLike, nameLike, nameLike, nameLike);
  }
  if (prefecture) {
    where += ' AND prefecture = ?';
    binds.push(prefecture);
  }

  return {
    filter,
    nameLike,
    prefecture,
    where,
    binds,
  };
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildOrdersCsv(orders, filter) {
  const filterLabel = {
    pending: '未発送',
    shipped: '発送済',
    cancelled: 'キャンセル',
    bank_pending: '振込待ち',
  }[filter] || filter;

  const header = [
    '予約番号',
    '姓',
    '名',
    'セイ',
    'メイ',
    '郵便番号',
    '都道府県',
    '住所1',
    '住所2',
    '電話',
    'メール',
    '数量',
    '合計金額',
    '決済',
    '予約ステータス',
    'キャンセル理由',
    '振込先銀行',
    '振込先支店',
    '振込先口座番号',
    'お客様備考',
    '管理メモ',
    '予約日時',
  ];

  const lines = [
    `\uFEFFYellow Pearl ${filterLabel}一覧`,
    header.join(','),
    ...orders.map((o) => {
      const bank = parseBankTransferInfo(o) ?? {};
      return [
        o.order_id,
        o.last_name,
        o.first_name,
        o.last_name_kana,
        o.first_name_kana,
        o.postal,
        o.prefecture,
        o.address1,
        o.address2,
        o.phone,
        o.email,
        o.quantity,
        o.total_amount,
        o.payment_status,
        o.status,
        o.status === ORDER_STATUS_CANCELLED ? cancelReasonLabel(o) : '',
        bank.bank_name ?? '',
        bank.branch_name ?? '',
        bank.account_number ?? '',
        o.note,
        o.admin_note,
        o.created_at,
      ].map(csvEscape).join(',');
    }),
  ];
  return lines.join('\r\n');
}

async function enrichOrdersWithPaymentFlags(db, orders) {
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.order_id);
  const placeholders = ids.map(() => '?').join(',');
  const eventRows = await db.prepare(
    `SELECT order_id, event_type FROM order_events
     WHERE order_id IN (${placeholders})
       AND (event_type = 'bank_transfer_pending' OR event_type LIKE 'payment_failed_%')
     ORDER BY id DESC`
  ).bind(...ids).all();

  const bankPending = new Set();
  const failReason = new Map();
  for (const ev of eventRows.results ?? []) {
    if (ev.event_type === 'bank_transfer_pending') {
      bankPending.add(ev.order_id);
    } else if (ev.event_type.startsWith('payment_failed_') && !failReason.has(ev.order_id)) {
      failReason.set(ev.order_id, ev.event_type);
    }
  }

  return orders.map((o) => ({
    ...o,
    bank_transfer_pending: bankPending.has(o.order_id),
    payment_fail_reason: failReason.get(o.order_id) || null,
  }));
}

export async function handleAdminOrders(env, CORS, url) {
  const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
  const pageRaw = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(limitRaw, 1), 100);
  const page = Number.isNaN(pageRaw) ? 1 : Math.max(pageRaw, 1);
  const { filter, nameLike, prefecture, where, binds } = buildOrdersListQuery(url);

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM orders WHERE ${where}`
  ).bind(...binds).first();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;

  const rows = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  const orders = await enrichOrdersWithPaymentFlags(env.DB, rows.results ?? []);

  return json({
    orders,
    filter,
    name: nameLike ? nameLike.slice(1, -1) : '',
    prefecture,
    page: safePage,
    limit,
    total,
    total_pages: totalPages,
  }, 200, CORS);
}

export async function handleAdminOrdersExport(env, CORS, url) {
  const { filter, where, binds } = buildOrdersListQuery(url);
  const rows = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE ${where} ORDER BY id DESC`
  ).bind(...binds).all();

  const orders = await enrichOrdersWithPaymentFlags(env.DB, rows.results ?? []);
  const csv = buildOrdersCsv(orders, filter);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="yellow-pearl-orders-${filter}-${stamp}.csv"`,
    },
  });
}

/**
 * Stripe の Checkout Session を照会して未決済／キャンセル注文の正体を判定する。
 * complete かつ未払い = 銀行振込待ち、expired = 支払い前に離脱。
 */
function classifyStripeSession(session) {
  if (!session) return 'stripe_error';
  if (session.payment_status === 'paid') return 'paid';
  if (session.status === 'complete') return 'bank_transfer_pending';
  if (session.status === 'expired') return 'abandoned_expired';
  if (session.status === 'open') return 'still_open';
  return 'unknown';
}

/**
 * scope=unpaid: 振込待ちフラグを補完。
 * scope=cancelled: 誤ってキャンセルされた振込待ちを検出し、apply=1 で予約へ戻す。
 */
export async function handleAdminOrdersReconcile(env, CORS, url) {
  const scope = url.searchParams.get('scope') === 'unpaid' ? 'unpaid' : 'cancelled';
  const apply = url.searchParams.get('apply') === '1';
  const limitRaw = parseInt(url.searchParams.get('limit') || '60', 10);
  const limit = Number.isNaN(limitRaw) ? 60 : Math.min(Math.max(limitRaw, 1), 100);

  // 既に判定済みの予約は除外し、押すたびに残りだけを処理して収束させる。
  // 振込先が未保存のものは判定済みでも拾い直す（後付けした項目を埋めるため）
  const stateFilter = scope === 'unpaid'
    ? `payment_status = '${PAYMENT_UNPAID}' AND status = '${ORDER_STATUS_RESERVED}'
       AND (
         (o.bank_transfer_info IS NULL AND NOT EXISTS (
           SELECT 1 FROM order_events e
           WHERE e.order_id = o.order_id AND e.event_type = 'bank_transfer_info_unavailable'
         ))
         OR NOT EXISTS (
           SELECT 1 FROM order_events e
           WHERE e.order_id = o.order_id AND e.event_type = 'bank_transfer_pending'
         )
       )`
    : `payment_status = '${PAYMENT_FAILED}' AND status = '${ORDER_STATUS_CANCELLED}'
       AND NOT EXISTS (
         SELECT 1 FROM order_events e
         WHERE e.order_id = o.order_id AND e.event_type LIKE 'payment_failed_%'
       )`;

  const rows = await env.DB.prepare(
    `SELECT o.order_id, o.email, o.quantity, o.total_amount, o.created_at, o.stripe_session_id,
       (SELECT e.event_type FROM order_events e
        WHERE e.order_id = o.order_id AND e.event_type LIKE 'payment_failed_%'
        ORDER BY e.id DESC LIMIT 1) AS payment_fail_reason
     FROM orders o
     WHERE o.${ORDER_NOT_ARCHIVED} AND ${stateFilter} AND o.stripe_session_id IS NOT NULL
     ORDER BY o.created_at DESC
     LIMIT ?`
  ).bind(limit).all();

  const fallbackMode = inventoryStripeMode(await fetchInventoryRow(env.DB));
  const counts = {};
  const items = [];
  let changed = 0;
  let bankInfoSaved = 0;

  for (const row of rows.results ?? []) {
    const mode = stripeModeFromResourceId(row.stripe_session_id) ?? fallbackMode;
    let session = null;
    if (isStripeEnabledForMode(env, mode)) {
      try {
        session = await stripeFetch(
          env,
          `/checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`,
          { method: 'GET' },
          mode,
        );
      } catch {
        session = null;
      }
    }

    const classification = classifyStripeSession(session);
    counts[classification] = (counts[classification] ?? 0) + 1;

    let action = 'none';
    if (classification === 'bank_transfer_pending') {
      if (scope === 'unpaid') {
        if (apply) {
          const res = await markBankTransferPending(env, row.order_id, session);
          if (res.stored) bankInfoSaved += 1;
          action = res.flagged ? 'flagged' : (res.stored ? 'info_stored' : 'already_flagged');
        } else {
          action = 'would_flag';
        }
      } else if (apply) {
        action = await restoreBankTransferOrder(env, row.order_id, row.quantity, session)
          ? 'restored'
          : 'restore_failed';
      } else {
        action = 'would_restore';
      }
    } else if (classification === 'abandoned_expired' && scope === 'unpaid') {
      // 失効済みセッションが在庫を押さえたままなので、cron を待たずに解放する
      action = apply
        ? (await markOrderFailedAndReleaseStock(env.DB, row.order_id, 'payment_failed_expired')
          ? 'released'
          : 'release_failed')
        : 'would_release';
    } else if (scope === 'cancelled' && !row.payment_fail_reason) {
      // 記録が入る前にキャンセルされた分の理由を Stripe の状態から埋める
      const backfill = {
        abandoned_expired: 'payment_failed_expired',
        still_open: 'payment_failed_expired',
      }[classification];
      if (backfill) {
        action = 'would_label';
        if (apply) {
          await logOrderEvent(env.DB, row.order_id, backfill, 'backfill:reconcile');
          action = 'labeled';
        }
      }
    }
    if (['flagged', 'info_stored', 'restored', 'released', 'labeled'].includes(action)) {
      changed += 1;
    }

    items.push({
      order_id: row.order_id,
      email: row.email,
      quantity: row.quantity,
      total_amount: row.total_amount,
      created_at: row.created_at,
      session_status: session?.status ?? null,
      session_payment_status: session?.payment_status ?? null,
      payment_method_types: Array.isArray(session?.payment_method_types)
        ? session.payment_method_types.join(',')
        : null,
      classification,
      action,
    });
  }

  return json({
    scope,
    apply,
    scanned: items.length,
    changed,
    bank_info_saved: bankInfoSaved,
    counts,
    items,
  }, 200, CORS);
}

/** 誤キャンセルされた振込待ちを未決済／予約へ戻し、在庫を再確保する */
async function restoreBankTransferOrder(env, orderId, quantity, session) {
  const db = env.DB;
  if (!(await decrementStock(db, quantity))) return false;

  const restored = await db.prepare(
    `UPDATE orders SET status = ?, payment_status = ?
     WHERE order_id = ? AND status = ? AND payment_status = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(
    ORDER_STATUS_RESERVED, PAYMENT_UNPAID, orderId, ORDER_STATUS_CANCELLED, PAYMENT_FAILED,
  ).run();

  if ((restored.meta?.changes ?? 0) === 0) {
    await incrementStock(db, quantity);
    return false;
  }

  await logOrderEvent(db, orderId, 'restored', 'reconcile:bank_transfer_pending');
  await markBankTransferPending(env, orderId, session);
  return true;
}

export async function handleAdminOrderUpdate(request, env, CORS, orderId) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const { status, admin_note: adminNote = '' } = body;
  if (!ORDER_STATUSES.includes(status)) {
    return json({ error: 'ステータスが不正です' }, 400, CORS);
  }
  if (adminNote.length > MAX_LEN.admin_note) {
    return json({ error: '特記事項が長すぎます' }, 400, CORS);
  }

  const wantsContactUpdate = body.last_name !== undefined;
  let contact = null;
  if (wantsContactUpdate) {
    const parsed = validateOrderContactFields(body);
    if (parsed.error) return json({ error: parsed.error }, 400, CORS);
    contact = parsed.data;
  }

  const order = await env.DB.prepare(
    `SELECT quantity, status, payment_status, stripe_session_id, stripe_payment_id,
      last_name, first_name, last_name_kana, first_name_kana,
      email, phone, postal, prefecture, address1, address2
     FROM orders WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);

  if (contact && order.status === ORDER_STATUS_CANCELLED) {
    return json({ error: 'キャンセル済みの予約の連絡先は変更できません' }, 400, CORS);
  }

  const oldStatus = order.status || ORDER_STATUS_RESERVED;
  const qty = order.quantity;

  if (oldStatus !== ORDER_STATUS_CANCELLED && status === ORDER_STATUS_CANCELLED) {
    if (order.payment_status === PAYMENT_PAID) {
      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, admin_note = ?
         WHERE order_id = ? AND payment_status = ? AND status != ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(ORDER_STATUS_CANCELLED, adminNote, orderId, PAYMENT_PAID, ORDER_STATUS_CANCELLED).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（決済状態が変更されています）' }, 409, CORS);
      }

      const stripeMode = resolveStripeMode({
        sessionId: order.stripe_session_id,
        paymentIntentId: order.stripe_payment_id,
      });
      const refund = await refundStripePayment(env, {
        paymentIntentId: order.stripe_payment_id,
        sessionId: order.stripe_session_id,
        mode: stripeMode,
      });
      if (refund.error) {
        await env.DB.prepare(
          `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ?`
        ).bind(oldStatus, '', orderId).run();
        return json({ error: refund.error }, refund.status, CORS);
      }

      await incrementStock(env.DB, qty);

      const payUpdate = await env.DB.prepare(
        `UPDATE orders SET payment_status = ?, stripe_payment_id = COALESCE(?, stripe_payment_id)
         WHERE order_id = ? AND payment_status = ?`
      ).bind(PAYMENT_REFUNDED, refund.payment_intent_id ?? null, orderId, PAYMENT_PAID).run();

      if ((payUpdate.meta?.changes ?? 0) === 0) {
        await logOrderEvent(env.DB, orderId, 'refund_db_sync_failed', refund.refund_id ?? '');
        return json({ error: '返金は完了しましたが記録に失敗しました。管理者に連絡してください。' }, 500, CORS);
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', `refunded:${PAYMENT_PAID}`);
      await maybeSendCancellationEmail(env, orderId, { refunded: true });
    } else if (order.payment_status === PAYMENT_UNPAID) {
      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, admin_note = ?
         WHERE order_id = ? AND payment_status = ? AND status != ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(
        ORDER_STATUS_CANCELLED, PAYMENT_CANCELLED, adminNote, orderId, PAYMENT_UNPAID, ORDER_STATUS_CANCELLED,
      ).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（決済が完了した可能性があります）' }, 409, CORS);
      }

      await incrementStock(env.DB, qty);

      if (order.stripe_session_id) {
        await expireStripeCheckoutSession(env, order.stripe_session_id, {
          mode: resolveStripeMode({ sessionId: order.stripe_session_id }),
        });
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', `admin:${PAYMENT_CANCELLED}`);
      await maybeSendCancellationEmail(env, orderId, { refunded: false });
    } else {
      const oldPaymentStatus = order.payment_status;
      const paymentStatus = oldPaymentStatus === PAYMENT_FAILED
        ? PAYMENT_CANCELLED
        : oldPaymentStatus;

      const lock = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, admin_note = ?
         WHERE order_id = ? AND status = ? AND payment_status = ? AND ${ORDER_NOT_ARCHIVED}`
      ).bind(
        ORDER_STATUS_CANCELLED, paymentStatus, adminNote,
        orderId, oldStatus, oldPaymentStatus,
      ).run();

      if ((lock.meta?.changes ?? 0) === 0) {
        return json({ error: 'キャンセルできません（状態が変更されています）' }, 409, CORS);
      }

      if (orderHoldsStock(oldPaymentStatus)) {
        await incrementStock(env.DB, qty);
      }

      await logOrderEvent(env.DB, orderId, 'cancelled', oldPaymentStatus);
      await maybeSendCancellationEmail(env, orderId, {
        refunded: oldPaymentStatus === PAYMENT_REFUNDED,
      });
    }
  } else if (oldStatus === ORDER_STATUS_CANCELLED && status !== ORDER_STATUS_CANCELLED) {
    if (
      order.payment_status === PAYMENT_PAID
      || order.payment_status === PAYMENT_REFUNDED
    ) {
      return json({ error: '決済済み・返金済みの予約は再予約に戻せません' }, 400, CORS);
    }
    if (!(await decrementStock(env.DB, qty))) {
      return json({ error: '在庫が不足しているため、キャンセルから戻せません' }, 409, CORS);
    }
    try {
      const restored = await env.DB.prepare(
        `UPDATE orders SET status = ?, payment_status = ?, stripe_session_id = NULL, admin_note = ?
         WHERE order_id = ? AND status = ? AND ${ORDER_NOT_ARCHIVED}
           AND payment_status NOT IN (?, ?)`
      ).bind(
        status, PAYMENT_UNPAID, adminNote, orderId,
        ORDER_STATUS_CANCELLED, PAYMENT_PAID, PAYMENT_REFUNDED,
      ).run();
      if ((restored.meta?.changes ?? 0) === 0) {
        await incrementStock(env.DB, qty);
        return json({ error: '再予約に戻せません（状態が変更されています）' }, 409, CORS);
      }
      await logOrderEvent(env.DB, orderId, 'restored', status);
    } catch {
      await incrementStock(env.DB, qty);
      return json({ error: '予約の更新に失敗しました' }, 500, CORS);
    }
  } else {
    if (
      status === ORDER_STATUS_DONE
      && order.payment_status !== PAYMENT_PAID
    ) {
      return json({ error: '未決済の予約は発送済みにできません' }, 400, CORS);
    }
    await env.DB.prepare(
      `UPDATE orders SET status = ?, admin_note = ? WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
    ).bind(status, adminNote, orderId).run();

    if (contact) {
      await updateOrderContact(env.DB, orderId, contact, order);
    }
  }

  const updated = await env.DB.prepare(
    `SELECT ${ORDER_SELECT} FROM orders WHERE order_id = ?`
  ).bind(orderId).first();

  return json({ order: updated }, 200, CORS);
}

export async function handleAdminResendConfirmationEmail(env, CORS, orderId) {
  const result = await resendConfirmationEmail(env, orderId);
  if (result.error) {
    return json({ error: result.error }, result.status ?? 500, CORS);
  }
  return json({ ok: true }, 200, CORS);
}

export async function handleAdminOrderDelete(env, CORS, orderId, adminEmail = '') {
  const order = await env.DB.prepare(
    `SELECT status FROM orders WHERE order_id = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(orderId).first();

  if (!order) return json({ error: '予約が見つかりません' }, 404, CORS);
  if (order.status !== ORDER_STATUS_CANCELLED) {
    return json({ error: 'キャンセル済みの予約のみアーカイブできます' }, 400, CORS);
  }

  const archiveResult = await env.DB.prepare(
    `UPDATE orders SET archived_at = datetime('now', '+9 hours'), archived_by = ?
     WHERE order_id = ? AND status = ? AND ${ORDER_NOT_ARCHIVED}`
  ).bind(adminEmail, orderId, ORDER_STATUS_CANCELLED).run();

  if ((archiveResult.meta?.changes ?? 0) === 0) {
    return json({ error: 'アーカイブできませんでした' }, 409, CORS);
  }

  await logOrderEvent(env.DB, orderId, 'archived', adminEmail);
  return json({ ok: true }, 200, CORS);
}

export async function handleAdminStats(env, CORS) {
  const rows = await env.DB.prepare(
    `SELECT strftime('%Y', created_at) AS year,
            COUNT(*) AS order_count,
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(total_amount), 0) AS amount
     FROM orders
     WHERE ${BOOKKEEPING_ORDER_FILTER}
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
