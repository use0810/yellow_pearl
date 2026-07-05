let rateLimitTableReady = false;

export async function ensureRateLimitTable(db) {
  if (rateLimitTableReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL
    )`
  ).run();
  rateLimitTableReady = true;
}

/** 上限超えなら true（Stripe Webhook は除外すること） */
export async function isRateLimited(env, bucket, ip, limit, windowMinutes) {
  await ensureRateLimitTable(env.DB);
  const windowMs = windowMinutes * 60 * 1000;
  const windowId = Math.floor(Date.now() / windowMs);
  const key = `${bucket}:${ip}:${windowId}`;
  const expiresAt = new Date((windowId + 1) * windowMs).toISOString();

  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`
  ).bind(key, expiresAt).run();

  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first();
  return (row?.count ?? 0) > limit;
}
