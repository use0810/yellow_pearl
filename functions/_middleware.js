/** Pages ミドルウェア（サイト全体 Basic 認証は無効） */
export async function onRequest(context) {
  return context.next();
}
