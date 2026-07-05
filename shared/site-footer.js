/** 全公開ページ共通フッター */
const FOOTER_HTML = `
  <div class="footer-logo">YELLOW PEARL</div>
  <div class="footer-org">郷のきみの会</div>
  <div class="footer-sub">郷のきみ プレミアムライン ／ 青森県新郷村</div>
  <div class="footer-legal-row">
    <a href="privacy.html" class="footer-legal">プライバシーポリシー</a>
    <span class="footer-legal-sep" aria-hidden="true">｜</span>
    <a href="tokusho.html" class="footer-legal">特定商取引法に基づく表記</a>
  </div>
  <p class="footer-note">
    本商品は当サイトでは年間1,000本限定のため、予定数に達し次第受付を終了いたします。
  </p>
  <p class="footer-copy">© 郷のきみの会 — Yellow Pearl, Shingo Village, Aomori</p>
`;

export function mountSiteFooter(container) {
  if (container) container.innerHTML = FOOTER_HTML;
}

const el = document.getElementById('site-footer');
if (el) mountSiteFooter(el);
