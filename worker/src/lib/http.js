export const DEFAULT_ORIGINS = 'https://yellow-pearl.com,https://www.yellow-pearl.com';

export function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS;
  if (raw === '*') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function buildCors(env, request, { credentials = false } = {}) {
  const allowed = parseAllowedOrigins(env);
  const origin = request?.headers?.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (credentials) headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...headers,
    },
  });
}

export function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `YP-${ts}-${rand}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
