import { json } from './http.js';

function accessConfigured(env) {
  return typeof env.ACCESS_TEAM_DOMAIN === 'string' && env.ACCESS_TEAM_DOMAIN.trim().length > 0;
}

function parseAdminAllowedEmails(env) {
  const raw = env.ADMIN_ALLOWED_EMAILS?.trim();
  if (!raw) return null;
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmailAllowed(email, allowed) {
  if (!allowed?.length) return true;
  if (!email || typeof email !== 'string') return false;
  return allowed.includes(email.trim().toLowerCase());
}

function accessLogoutUrl(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!team) return null;
  const returnTo = `${new URL(request.url).origin}/admin.html`;
  return `https://${team}/cdn-cgi/access/logout?return_to=${encodeURIComponent(returnTo)}`;
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const ACCESS_CERTS_TTL_MS = 3600_000;

function parseJwtPart(part) {
  const jsonStr = atob(part.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (part.length % 4)) % 4));
  return JSON.parse(jsonStr);
}

let accessCertsCache = { keys: null, fetchedAt: 0 };

async function getAccessCerts(teamDomain) {
  if (accessCertsCache.keys && Date.now() - accessCertsCache.fetchedAt < ACCESS_CERTS_TTL_MS) {
    return accessCertsCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Access certs fetch failed');
  const data = await res.json();
  accessCertsCache = { keys: data.keys ?? [], fetchedAt: Date.now() };
  return accessCertsCache.keys;
}

async function verifyAccessJwtSignature(token, teamDomain) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const header = parseJwtPart(parts[0]);
  const keys = await getAccessCerts(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(parts[2]),
    data,
  );
}

async function verifyAccessJwt(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!jwt || !teamDomain) return null;

  try {
    const payload = parseJwtPart(jwt.split('.')[1]);
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    if (env.ACCESS_AUD && payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(env.ACCESS_AUD)) return null;
    }
    if (!(await verifyAccessJwtSignature(jwt, teamDomain))) return null;

    const email = typeof payload.email === 'string' ? payload.email : null;
    if (!isAdminEmailAllowed(email, parseAdminAllowedEmails(env))) return null;

    return { ok: true, via: 'access', email };
  } catch {
    return null;
  }
}

export async function verifyAdminAuth(request, env) {
  if (!accessConfigured(env)) {
    return { error: '管理者認証（Cloudflare Access）が設定されていません', status: 503 };
  }
  const access = await verifyAccessJwt(request, env);
  if (access) return access;
  return { error: '認証が必要です', status: 401 };
}

export async function handleAdminSessionCheck(request, env, CORS) {
  const auth = await verifyAdminAuth(request, env);
  if (auth.error) {
    return json({ authenticated: false, error: auth.error }, auth.status, CORS);
  }
  return json({
    authenticated: true,
    via: auth.via,
    email: auth.email ?? null,
    logout_url: accessLogoutUrl(request, env),
  }, 200, CORS);
}
