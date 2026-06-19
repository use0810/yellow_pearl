const REALM = 'Yellow Pearl';

function isAuthorized(request, password) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return pass === password;
  } catch {
    return false;
  }
}

function challenge() {
  return new Response('認証が必要です', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Pages: HTML・静的ファイル用 Basic 認証（SITE_PASSWORD 未設定ならスキップ） */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!env.SITE_PASSWORD) return next();
  if (url.pathname === '/admin.html' || url.pathname.startsWith('/admin')) return next();

  if (isAuthorized(request, env.SITE_PASSWORD)) return next();
  return challenge();
}
