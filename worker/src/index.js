import { buildCors, clientIp, json } from './lib/http.js';
import { handleAdminSessionCheck, verifyAdminAuth } from './lib/auth.js';
import {
  handleCheckout,
  handleCheckoutAbort,
  handleCheckoutReturn,
  handleStripeWebhook,
} from './lib/checkout.js';
import { cleanupStaleOrders, fetchInventoryRow, handleStock, inventoryStripeMode } from './lib/inventory.js';
import { isRateLimited } from './lib/rate-limit.js';
import { isStripeEnabledForMode } from './lib/stripe.js';
import {
  handleAdminDashboard,
  handleAdminOrderDelete,
  handleAdminOrders,
  handleAdminOrdersExport,
  handleAdminOrdersReconcile,
  handleAdminOrderUpdate,
  handleAdminResendConfirmationEmail,
  handleAdminShippingLabelCreate,
  handleAdminShippingLabelDelete,
  handleAdminShippingLabelDownload,
  handleAdminShippingLabelList,
  handleAdminShippingLabelRevert,
  handleAdminStats,
} from './lib/admin-orders.js';
import {
  handleAdminInventoryUpdate,
  handleAdminShippingUpdate,
  handleAdminStripeModeUpdate,
} from './lib/admin-inventory.js';
import {
  handleAdminBookkeeping,
  handleAdminBookkeepingExpensesUpdate,
  handleAdminBookkeepingExport,
} from './lib/bookkeeping.js';
import { handleIndexHtml, isIndexHtmlPath } from './lib/html-seo.js';
import {
  retryFailedConfirmationEmails,
  sendPendingBankTransferExpiredEmails,
} from './lib/email.js';

async function handleApi(request, env) {
  const url = new URL(request.url);
  const isAdmin = url.pathname.startsWith('/api/admin/');
  const CORS = buildCors(env, request, { credentials: isAdmin });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (!env.DB) {
    return json({ error: 'DB binding が設定されていません' }, 500, CORS);
  }

  const ip = clientIp(request);

  if (url.pathname === '/api/reserve' && request.method === 'POST' && request.headers.get('Stripe-Signature')) {
    if (await isRateLimited(env, 'webhook', ip, 120, 1)) {
      return new Response('Too many requests', { status: 429 });
    }
    return handleStripeWebhook(request, env);
  }

  if (url.pathname === '/api/reserve' && request.method === 'POST') {
    if (await isRateLimited(env, 'reserve', ip, 10, 1)) {
      return json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' }, 429, CORS);
    }
  }
  if (url.pathname === '/api/stock' && request.method === 'GET' && !url.searchParams.get('session_id')) {
    if (await isRateLimited(env, 'stock', ip, 60, 1)) {
      return json({ error: 'リクエストが多すぎます' }, 429, CORS);
    }
  }

  if (url.pathname === '/api/stock' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session_id');
    if (sessionId) return handleCheckoutReturn(env, CORS, sessionId);
    return handleStock(env, CORS);
  }

  if (url.pathname === '/api/checkout/abort' && request.method === 'POST') {
    if (await isRateLimited(env, 'abort', ip, 20, 1)) {
      return json({ error: 'リクエストが多すぎます' }, 429, CORS);
    }
    return handleCheckoutAbort(env, CORS, url.searchParams.get('session_id'));
  }

  if (url.pathname === '/api/reserve' && request.method === 'POST') {
    const inv = await fetchInventoryRow(env.DB);
    const stripeMode = inventoryStripeMode(inv);
    if (isStripeEnabledForMode(env, stripeMode)) return handleCheckout(request, env, CORS);
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  if (isAdmin) {
    if (url.pathname === '/api/admin/session' && request.method === 'GET') {
      return handleAdminSessionCheck(request, env, CORS);
    }

    const auth = await verifyAdminAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status, CORS);

    const adminRateKey = auth.email ? `${ip}:${auth.email}` : ip;
    if (await isRateLimited(env, 'admin', adminRateKey, 120, 1)) {
      return json({ error: 'リクエストが多すぎます' }, 429, CORS);
    }

    if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
      return handleAdminDashboard(env, CORS);
    }

    if (url.pathname === '/api/admin/inventory' && request.method === 'PUT') {
      return handleAdminInventoryUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/shipping' && request.method === 'PUT') {
      return handleAdminShippingUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/stripe-mode' && request.method === 'PUT') {
      return handleAdminStripeModeUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
      return handleAdminStats(env, CORS);
    }

    if (url.pathname === '/api/admin/bookkeeping' && request.method === 'GET') {
      return handleAdminBookkeeping(env, CORS, url);
    }

    if (url.pathname === '/api/admin/bookkeeping/expenses' && request.method === 'PUT') {
      return handleAdminBookkeepingExpensesUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/bookkeeping/export.csv' && request.method === 'GET') {
      return handleAdminBookkeepingExport(env, CORS, url);
    }

    if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
      return handleAdminOrders(env, CORS, url);
    }

    if (url.pathname === '/api/admin/orders/export.csv' && request.method === 'GET') {
      return handleAdminOrdersExport(env, CORS, url);
    }

    if (url.pathname === '/api/admin/orders/reconcile' && request.method === 'GET') {
      return handleAdminOrdersReconcile(env, CORS, url);
    }

    if (url.pathname === '/api/admin/shipping-labels' && request.method === 'GET') {
      return handleAdminShippingLabelList(env, CORS);
    }

    if (url.pathname === '/api/admin/shipping-labels' && request.method === 'POST') {
      return handleAdminShippingLabelCreate(request, env, CORS, auth.email ?? '');
    }

    if (url.pathname === '/api/admin/shipping-labels/revert' && request.method === 'POST') {
      return handleAdminShippingLabelRevert(request, env, CORS);
    }

    const labelDownloadMatch = url.pathname.match(
      /^\/api\/admin\/shipping-labels\/([^/]+)\/download\.csv$/,
    );
    if (labelDownloadMatch && request.method === 'GET') {
      return handleAdminShippingLabelDownload(env, CORS, labelDownloadMatch[1]);
    }

    const labelMatch = url.pathname.match(/^\/api\/admin\/shipping-labels\/([^/]+)$/);
    if (labelMatch && request.method === 'DELETE') {
      return handleAdminShippingLabelDelete(env, CORS, labelMatch[1]);
    }

    const resendEmailMatch = url.pathname.match(
      /^\/api\/admin\/orders\/([^/]+)\/resend-confirmation-email$/,
    );
    if (resendEmailMatch && request.method === 'POST') {
      return handleAdminResendConfirmationEmail(env, CORS, resendEmailMatch[1]);
    }

    const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (orderMatch && request.method === 'PUT') {
      return handleAdminOrderUpdate(request, env, CORS, orderMatch[1]);
    }
    if (orderMatch && request.method === 'DELETE') {
      return handleAdminOrderDelete(env, CORS, orderMatch[1], auth.email ?? '');
    }
  }

  return json({ error: 'Not found' }, 404, CORS);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // トップページの Product JSON-LD に DB の税込単価を埋め込む（Search Console 対策）
    if (request.method === 'GET' && isIndexHtmlPath(url.pathname)) {
      return handleIndexHtml(request, env);
    }

    return fetch(request);
  },

  async scheduled(event, env, ctx) {
    // 09:20 JST (= 00:20 UTC): 日次クォータ回復後の再送と、深夜に期限切れになった予約への案内
    if (event.cron === '20 0 * * *') {
      ctx.waitUntil((async () => {
        await retryFailedConfirmationEmails(env);
        await sendPendingBankTransferExpiredEmails(env);
      })());
      return;
    }
    ctx.waitUntil(cleanupStaleOrders(env));
  },
};
