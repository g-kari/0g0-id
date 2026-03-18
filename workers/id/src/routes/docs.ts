import { Hono } from 'hono';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>0g0 ID API ドキュメント</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; line-height: 1.6; }
    .container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }
    header { border-bottom: 1px solid #2d3748; padding-bottom: 2rem; margin-bottom: 2rem; }
    header h1 { font-size: 2rem; font-weight: 700; color: #fff; }
    header p { color: #a0aec0; margin-top: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-right: 0.5rem; }
    .get { background: #1a365d; color: #63b3ed; }
    .post { background: #1c4532; color: #68d391; }
    .patch { background: #2d3003; color: #d6c060; }
    .delete { background: #451a1a; color: #fc8181; }
    section { margin-bottom: 3rem; }
    section h2 { font-size: 1.25rem; font-weight: 600; color: #fff; padding: 0.75rem 0; border-bottom: 1px solid #2d3748; margin-bottom: 1rem; }
    .endpoint { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    .endpoint-title { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
    .path { font-family: 'Courier New', monospace; font-size: 0.95rem; color: #e2e8f0; }
    .auth-required { font-size: 0.75rem; color: #a0aec0; border: 1px solid #4a5568; padding: 0.15rem 0.5rem; border-radius: 4px; }
    .admin-only { font-size: 0.75rem; color: #f6ad55; border: 1px solid #744210; padding: 0.15rem 0.5rem; border-radius: 4px; }
    .desc { color: #a0aec0; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .params { margin-top: 0.75rem; }
    .params h4 { font-size: 0.8rem; text-transform: uppercase; color: #718096; margin-bottom: 0.4rem; letter-spacing: 0.05em; }
    .param { display: flex; gap: 1rem; font-size: 0.85rem; padding: 0.3rem 0; border-top: 1px solid #2d3748; }
    .param-name { font-family: 'Courier New', monospace; color: #63b3ed; min-width: 130px; }
    .param-type { color: #68d391; min-width: 70px; }
    .param-desc { color: #a0aec0; }
    .response-block { background: #0d1117; border-radius: 6px; padding: 1rem; margin-top: 0.75rem; font-family: 'Courier New', monospace; font-size: 0.8rem; color: #a0aec0; white-space: pre; overflow-x: auto; }
    footer { text-align: center; color: #4a5568; font-size: 0.85rem; padding-top: 2rem; border-top: 1px solid #2d3748; }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>0g0 ID API</h1>
    <p>統合ID基盤（IdP）の REST API ドキュメント。ベースURL: <code style="color:#63b3ed">https://id.0g0.xyz</code></p>
  </header>

  <section>
    <h2>認証フロー</h2>
    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/auth/login</span>
      </div>
      <div class="desc">BFFからのリダイレクトを受け取り、Googleの認可画面へリダイレクトする。</div>
      <div class="params">
        <h4>クエリパラメータ</h4>
        <div class="param"><span class="param-name">redirect_to</span><span class="param-type">string</span><span class="param-desc">コールバック先URL（user/adminオリジンのみ許可）</span></div>
        <div class="param"><span class="param-name">state</span><span class="param-type">string</span><span class="param-desc">CSRF対策用ランダム値（BFF生成）</span></div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/auth/callback</span>
      </div>
      <div class="desc">Googleからのコールバック。ユーザーを作成/更新し、ワンタイム認可コード（60秒有効）を発行してBFFへリダイレクト。</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/auth/exchange</span>
      </div>
      <div class="desc">ワンタイムコードをアクセストークン（15分）＋リフレッシュトークン（30日）に交換する。Service Bindingsによるサーバー間通信専用。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">code</span><span class="param-type">string</span><span class="param-desc">ワンタイム認可コード（必須）</span></div>
      </div>
      <div class="response-block">{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "abc...",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": { "id": "...", "email": "...", "name": "...", "picture": "...", "role": "user" }
  }
}</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/auth/refresh</span>
      </div>
      <div class="desc">リフレッシュトークンを使って新しいアクセストークンを発行する（トークンローテーション）。再使用検出時はファミリー全体を失効させる。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">refresh_token</span><span class="param-type">string</span><span class="param-desc">有効なリフレッシュトークン（必須）</span></div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/auth/logout</span>
      </div>
      <div class="desc">リフレッシュトークンファミリー全体を失効させる。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">refresh_token</span><span class="param-type">string</span><span class="param-desc">失効させるトークン（省略時は何もしない）</span></div>
      </div>
    </div>
  </section>

  <section>
    <h2>ユーザー API</h2>
    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/users/me</span>
        <span class="auth-required">要認証</span>
      </div>
      <div class="desc">認証済みユーザー自身のプロフィール情報を返す。</div>
      <div class="response-block">{
  "data": { "id": "...", "email": "...", "name": "...", "picture": "...", "role": "user" }
}</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge patch">PATCH</span><span class="path">/api/users/me</span>
        <span class="auth-required">要認証</span>
      </div>
      <div class="desc">ユーザー名を更新する。Origin/RefererヘッダーによるCSRF検証あり。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">name</span><span class="param-type">string</span><span class="param-desc">新しい表示名（必須、空白のみ不可）</span></div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/users</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">ユーザー一覧を返す（ページネーション対応）。</div>
      <div class="params">
        <h4>クエリパラメータ</h4>
        <div class="param"><span class="param-name">limit</span><span class="param-type">number</span><span class="param-desc">1ページの件数（デフォルト50、最大100）</span></div>
        <div class="param"><span class="param-name">offset</span><span class="param-type">number</span><span class="param-desc">取得開始位置（デフォルト0）</span></div>
      </div>
      <div class="response-block">{
  "data": [{ "id": "...", "email": "...", "name": "...", "role": "user", "created_at": "..." }],
  "total": 42
}</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/users/me/connections</span>
        <span class="auth-required">要認証</span>
      </div>
      <div class="desc">ユーザーがアクティブなリフレッシュトークンを持つ連携サービス一覧を返す。</div>
      <div class="response-block">{
  "data": [{ "service_id": "...", "service_name": "...", "client_id": "...", "first_authorized_at": "...", "last_authorized_at": "..." }]
}</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge delete">DELETE</span><span class="path">/api/users/me/connections/:serviceId</span>
        <span class="auth-required">要認証</span>
      </div>
      <div class="desc">指定サービスへの連携を解除する（そのサービスの全リフレッシュトークンを失効）。Origin/RefererヘッダーによるCSRF検証あり。</div>
    </div>
  </section>

  <section>
    <h2>サービス管理 API</h2>
    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/services</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">登録済みサービス一覧を返す。</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/api/services</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">新しいサービスを登録する。<code>client_secret</code> は作成時のみ返却（再取得不可）。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">name</span><span class="param-type">string</span><span class="param-desc">サービス名（必須）</span></div>
        <div class="param"><span class="param-name">allowed_scopes</span><span class="param-type">string[]</span><span class="param-desc">許可スコープ一覧（省略時: ["profile","email"]）</span></div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge delete">DELETE</span><span class="path">/api/services/:id</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">サービスを削除する。</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/services/:id/redirect-uris</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">サービスの許可リダイレクトURI一覧を返す。</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/api/services/:id/redirect-uris</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">リダイレクトURIを追加する。HTTPS必須（localhost例外あり）、fragment禁止、自動正規化。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">uri</span><span class="param-type">string</span><span class="param-desc">追加するリダイレクトURI（必須）</span></div>
      </div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge delete">DELETE</span><span class="path">/api/services/:id/redirect-uris/:uriId</span>
        <span class="auth-required">要認証</span><span class="admin-only">管理者専用</span>
      </div>
      <div class="desc">リダイレクトURIを削除する。</div>
    </div>
  </section>

  <section>
    <h2>トークンイントロスペクション</h2>
    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge post">POST</span><span class="path">/api/token/introspect</span>
      </div>
      <div class="desc">RFC 7662 準拠のトークン検証エンドポイント。Basic認証（client_id:client_secret）が必要。</div>
      <div class="params">
        <h4>リクエストボディ（JSON）</h4>
        <div class="param"><span class="param-name">token</span><span class="param-type">string</span><span class="param-desc">検証するリフレッシュトークン</span></div>
      </div>
      <div class="response-block">{
  "active": true,
  "sub": "&lt;user_id&gt;",
  "exp": 1234567890
}</div>
    </div>
  </section>

  <section>
    <h2>公開エンドポイント</h2>
    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/.well-known/jwks.json</span>
      </div>
      <div class="desc">JWT署名検証用のES256公開鍵（JWK Set）を返す。</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/api/health</span>
      </div>
      <div class="desc">ヘルスチェック。</div>
      <div class="response-block">{ "status": "ok", "worker": "id", "timestamp": "..." }</div>
    </div>

    <div class="endpoint">
      <div class="endpoint-title">
        <span class="badge get">GET</span><span class="path">/docs</span>
      </div>
      <div class="desc">このドキュメント。</div>
    </div>
  </section>

  <section>
    <h2>エラーレスポンス形式</h2>
    <div class="endpoint">
      <div class="desc">エラー時はすべて以下の形式で返す。</div>
      <div class="response-block">{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}</div>
      <div class="params" style="margin-top:0.75rem">
        <h4>主なエラーコード</h4>
        <div class="param"><span class="param-name">BAD_REQUEST</span><span class="param-type">400</span><span class="param-desc">パラメータ不足・不正な値</span></div>
        <div class="param"><span class="param-name">UNAUTHORIZED</span><span class="param-type">401</span><span class="param-desc">認証失敗・トークン無効</span></div>
        <div class="param"><span class="param-name">FORBIDDEN</span><span class="param-type">403</span><span class="param-desc">権限不足・不正なオリジン</span></div>
        <div class="param"><span class="param-name">NOT_FOUND</span><span class="param-type">404</span><span class="param-desc">リソースが存在しない</span></div>
        <div class="param"><span class="param-name">CONFLICT</span><span class="param-type">409</span><span class="param-desc">重複（リダイレクトURIなど）</span></div>
        <div class="param"><span class="param-name">INTERNAL_ERROR</span><span class="param-type">500</span><span class="param-desc">サーバー内部エラー</span></div>
      </div>
    </div>
  </section>

  <footer>
    <p>0g0 ID &mdash; ES256 / Cloudflare Workers / D1</p>
  </footer>
</div>
</body>
</html>`;

app.get('/', (c) => {
  return c.html(HTML);
});

export default app;
