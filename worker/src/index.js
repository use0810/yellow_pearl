import { buildCors, clientIp, json } from './lib/http.js';
import { handleAdminSessionCheck, verifyAdminAuth } from './lib/auth.js';
import {
  handleCheckout,
  handleCheckoutReturn,
  handleStripeWebhook,
} from './lib/checkout.js';
import { cleanupStaleOrders, handleStock } from './lib/inventory.js';
import { isRateLimited } from './lib/rate-limit.js';
import { isStripeEnabled } from './lib/stripe.js';
import {
  handleAdminDashboard,
  handleAdminOrderDelete,
  handleAdminOrders,
  handleAdminOrderUpdate,
  handleAdminStats,
} from './lib/admin-orders.js';
import {
  handleAdminInventoryUpdate,
  handleAdminShippingUpdate,
} from './lib/admin-inventory.js';
import {
  handleAdminBookkeeping,
  handleAdminBookkeepingExpensesUpdate,
  handleAdminBookkeepingExport,
} from './lib/bookkeeping.js';

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
  const isStripeWebhook = !!request.headers.get('Stripe-Signature');

  if (!isStripeWebhook) {
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
  }

  if (url.pathname === '/api/stock' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session_id');
    if (sessionId) return handleCheckoutReturn(env, CORS, sessionId);
    return handleStock(env, CORS);
  }

  if (url.pathname === '/api/reserve' && request.method === 'POST') {
    if (request.headers.get('Stripe-Signature')) {
      return handleStripeWebhook(request, env);
    }
    if (isStripeEnabled(env)) return handleCheckout(request, env, CORS);
    return json({ error: '決済は現在利用できません' }, 503, CORS);
  }

  if (isAdmin) {
    if (url.pathname === '/api/admin/session' && request.method === 'GET') {
      return handleAdminSessionCheck(request, env, CORS);
    }

    const auth = await verifyAdminAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status, CORS);

    if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
      return handleAdminDashboard(env, CORS);
    }

    if (url.pathname === '/api/admin/inventory' && request.method === 'PUT') {
      return handleAdminInventoryUpdate(request, env, CORS);
    }

    if (url.pathname === '/api/admin/shipping' && request.method === 'PUT') {
      return handleAdminShippingUpdate(request, env, CORS);
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

    const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (orderMatch && request.method === 'PUT') {
      return handleAdminOrderUpdate(request, env, CORS, orderMatch[1]);
    }
    if (orderMatch && request.method === 'DELETE') {
      return handleAdminOrderDelete(env, CORS, orderMatch[1]);
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

    return fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupStaleOrders(env));
  },
};
