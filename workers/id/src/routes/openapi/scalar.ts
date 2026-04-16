// Scalar (API docs UI) レンダリング補助

// バージョン固定済みのScalar CDN URL（サプライチェーン攻撃リスク低減）
// SRIハッシュはデプロイパイプラインで付与すること
const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.49.1";

/**
 * ドキュメントページ（HTML）向けのContent-Security-Policy。
 * Scalar CDNスクリプト読み込みと同一オリジンへのfetchを許可する。
 * securityHeaders()が設定するデフォルトCSP（default-src 'none'）をオーバーライドして使用する。
 */
export const DOCS_CSP =
  "default-src 'none'; " +
  `script-src ${SCALAR_CDN}; ` +
  "connect-src 'self'; " +
  "style-src 'unsafe-inline'; " +
  "font-src 'self' data: https:; " +
  "img-src 'self' data: https:; " +
  "worker-src blob:; " +
  "frame-ancestors 'none'";

// ─── Scalar HTML テンプレート ────────────────────────────────────────
export function scalarHtml(specUrl: string, title: string, markdownUrl: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    #ai-link { position: fixed; bottom: 16px; right: 16px; z-index: 9999; background: #1a1a1a; color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; text-decoration: none; font-family: sans-serif; opacity: 0.8; }
    #ai-link:hover { opacity: 1; }
  </style>
</head>
<body>
  <a id="ai-link" href="${markdownUrl}">📄 Markdown版 (AI向け)</a>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="${SCALAR_CDN}" crossorigin="anonymous"></script>
</body>
</html>`;
}
