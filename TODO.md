# TODO

## セキュリティ / アーキテクチャ課題

### ~~[高] MCPセッションのインメモリ管理がWorkerスケールアウトに非対応~~ ✅

- **対応済み**: `mcp_sessions` テーブルをD1に追加（migration 0019）し、`transport.ts` のインメモリ `Map` をD1永続化に置き換え。`packages/shared/src/db/mcp-sessions.ts` にCRUD関数を追加し、id workerのCron Triggerで期限切れセッションを自動削除

### ~~[高] Dependabot脆弱性アラート（high 1件、moderate 1件）~~ ✅

- **対応済み**: picomatch@4.0.3 → 4.0.4 へアップデート
  - ReDoS脆弱性（GHSA-c2c7-rcm5-vvqj, High, CVSS 7.5）修正
  - POSIXキャラクタークラスのMethod Injection（GHSA-3v7f-55p6-f55p, Moderate）修正
  - vitest・viteの間接依存。`npm audit`で0件を確認済み

### ~~[中] 管理者ルートにBANチェックミドルウェアが未適用~~ ✅

- **対応済み**: `adminMiddleware` 内でDB問い合わせによるBANチェックを追加。全管理者ルートでBANされたユーザーのアクセスを即時遮断

### ~~[中] /auth/exchange と /auth/refresh が Service Bindings 保護なし~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`INTERNAL_SERVICE_SECRET` 環境変数による共有シークレット検証で、BFF以外の外部からの直接呼び出しをブロック。サービスOAuth（Basic認証）は引き続き許可

### ~~[低] /auth/logout が認証なしでアクセス可能~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`/auth/exchange` や `/auth/refresh` と同様に、BFF以外の外部からの直接呼び出しをブロック

### ~~[低] 使用済み認可コードの定期クリーンアップ~~ ✅

- **対応済み**: Cron Trigger（毎日0時UTC）で期限切れ・消費済みの認可コードとデバイスコードを自動削除。`cleanupExpiredAuthCodes`を`auth-codes.ts`に追加、`workers/id`のscheduledハンドラから実行

### ~~[低] 既存テストの不備（services, users テスト）~~ ✅

- **対応済み**: 両テストファイルの`beforeEach`にadminMiddleware用`findUserById`モックを追加。admin系ルートの「ユーザー不在」テストは`mockResolvedValueOnce`チェーンでadminMiddlewareとルートハンドラを分離。`admin.test.ts`のenv未設定も修正。全1286テストがパス

### ~~[低] matchRedirectUri で localhost 時に query string が無視される~~ ✅

- **対応済み**: `regUrl.search === reqUrl.search` を localhost 比較ロジックに追加。ポートは無視しつつ query string は厳密に比較するよう修正（2026-04-04）

### ~~[低] 既存テストの不備（admin-audit-logs, metrics テスト）~~ ✅

- **対応済み**: 両テストファイルの `vi.mock` に `findUserById` を追加し、`beforeEach` でBANされていない管理者ユーザーを返すモックを設定。全57テストがパス

### ~~[低] Device Code Grant の user_code ブルートフォース耐性~~ ✅

- **対応済み**: 認証ユーザー単位のレートリミッター `RATE_LIMITER_DEVICE_VERIFY` を追加（10回/分/ユーザー）。既存のIP単位レートリミット（30回/分）と二重防御でブルートフォースを緩和

### ~~[中] authorization_code grantでID tokenが発行されない（OIDC非準拠）~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `openid` スコープがある場合に `signIdToken` を呼び出すよう修正。device code grantと同じパターンでpairwise sub + nonce対応

### ~~[中] token exchangeでredirect_uriが正規化されない~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `normalizeRedirectUri` を呼び出してから `matchRedirectUri` で比較するよう修正（RFC 6749 §4.1.3準拠）

### ~~[中] /auth/loginと/auth/authorizeでredirect_uri検証が不一致~~ ✅

- **対応済み**: `/auth/login` の `isValidRedirectUri`（完全一致DB検索）を `listRedirectUris` + `matchRedirectUri`（ポート番号無視のlocalhost比較）に置換。`/auth/authorize` と同一ロジックに統一（RFC 8252 §7.3準拠）

### ~~[低] isBffSessionでnameの空文字チェック漏れ~~ ✅

- **対応済み**: `isBffSession` type guardで `name` フィールドにも空文字チェック（`!u['name']`）を追加。他のフィールド（access_token, id, email等）と整合

### ~~[低] fetchWithAuthのリフレッシュレスポンス未バリデーション~~ ✅

- **対応済み**: `fetchWithAuth` でリフレッシュレスポンスの `access_token`/`refresh_token` が非空文字列であることを実行時バリデーション。不正な場合はセッションCookieを削除して401を返す

### ~~[低] MCPセッションTTLが固定期限（スライディングウィンドウでない）~~ ✅

- **対応済み**: セッションに `lastActiveAt` フィールドを追加し、リクエストごとに更新。TTL判定を `createdAt` から `lastActiveAt` に変更してアイドルタイムアウト方式に

### ~~[低] MCP list_usersのsearchがemailのみ（説明と不一致）~~ ✅

- **対応済み**: `UserFilter` に `search` フィールドを追加し、`buildUserFilterClause` でemail OR nameの部分一致検索を実装。MCPツールのhandlerを `filter.search` に変更

### ~~[情報] matchRedirectUri の localhost/127.0.0.1 混在~~ ✅

- **対応済み**: hostname比較を削除し、`localhost` と `127.0.0.1` を同一ホストとして扱うよう変更（RFC 8252 §8.3 SHOULD準拠）。テスト2件追加（2026-04-04）

### ~~[低] Device Code Grant: approved_at / user_id のデータ不整合エッジケース~~ ✅

- **対応済み**: DB CHECK制約 `CHECK (approved_at IS NULL OR user_id IS NOT NULL)` を追加（migration 0018）

## 軽微な改善候補（低優先度）

### ~~[低] introspect エンドポイントの `token_type_hint` が未活用~~ ✅

- **対応済み**: `token_type_hint === 'access_token'` のとき JWT を先に検証し、失敗時はリフレッシュトークンにフォールバックする分岐を追加。`introspectRefreshToken` / `introspectJwtToken` ヘルパー関数に切り出してリファクタリングも実施（2026-04-04）

## セキュリティ / アーキテクチャ課題（新規）

### [高] PKCE が `token.ts` の authorization_code グラントで任意

- `code_challenge` が DB に存在しない場合は `code_verifier` なしでトークン発行可能
- パブリッククライアントでは PKCE を必須化すべき（RFC 7636 §4.4 SHOULD → 実質 MUST）
- 対応方針: `handleAuthorizationCodeGrant` で `code_challenge` が DB に保存されている場合のみ検証、かつコンフィデンシャルクライアント以外は必須化

### [高] `/api/token` エンドポイントのレートリミットが IP 単位のみ

- `client_id` 単位の追加制限が未実装
- IP ローテーションによるブルートフォースを防げない
- 対応方針: `RATE_LIMITER_TOKEN` を `client_id` キーでも設定し、IP 単位と二重防御

### [高] `unrevokeRefreshToken` の競合状態

- `token.ts` 側で `reuse_detected` チェックが未実施（`auth.ts` の `/refresh` では実施済み）
- 同一トークンを並行して複数回 unrevoke するリクエストが来た場合の安全性が保証されない
- 対応方針: `token.ts` のリフレッシュトークングラントに `reuse_detected` チェックを追加

### [中] RFC 7009 (Token Revocation) — アクセストークンの revoke が未実装

- 現状リフレッシュトークンの revoke のみ対応
- アクセストークンを revoke するには `jti` ブロックリスト（D1 または KV）が必要
- 対応方針: `revoked_access_tokens` テーブルまたは KV に `jti` を保存し、`introspect` / リソースサーバー側で参照

### [中] `resolveEffectiveScope`: スコープ未指定時に全 allowedScopes を付与

- 最小スコープポリシー（principle of least privilege）に反する
- 対応方針: スコープ未指定時は空セットを返すか、クライアントごとにデフォルトスコープを定義する設計の検討

### [中] `mcp_sessions` テーブルにユーザーIDが関連付けられていない

- セッションハイジャックが発生した場合にユーザーとセッションを紐付けて無効化できない
- 対応方針: `mcp_sessions` テーブルに `user_id` カラムを追加（migration 追加）し、セッション作成時に記録

## 完了済み（Device Code Grant 対応）

- [x] RFC 8628 §3.5: Device Code Grant の `slow_down` レスポンスに `Retry-After` ヘッダーを追加（`device.ts`）
- [x] `device.test.ts` を新規作成し 16テストを追加（RFC準拠・各エラーケース網羅）

## 完了済み

- [x] ~~MCPミドルウェアのBAN/Adminチェック順序修正~~ (2026-04-03, commit 9575641)
- [x] ~~Device Code Grant: approved_at/user_id 不整合防止のCHECK制約追加~~ (2026-04-03, migration 0018)
- [x] ~~管理者ルートにBANチェック追加~~ (2026-04-03, adminMiddleware内でDB確認)
- [x] ~~/auth/exchange, /auth/refresh にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware + INTERNAL_SERVICE_SECRET)
- [x] ~~/auth/logout にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware適用)
- [x] ~~Device Code user_code ブルートフォース耐性強化~~ (2026-04-03, 認証ユーザー単位レートリミッター追加)
- [x] ~~Service Bindingミドルウェア Basic認証バイパス修正~~ (2026-04-03, authenticateServiceで実際のクライアント認証情報を検証)
- [x] ~~本番環境INTERNAL_SERVICE_SECRET必須化~~ (2026-04-03, HTTPS環境で未設定時にバリデーションエラー)
- [x] ~~既存テストの不備修正（admin-audit-logs, metrics テスト）~~ (2026-04-03, findUserByIdモック追加で全57テストパス)
- [x] ~~使用済み認可コード・デバイスコードの定期クリーンアップ~~ (2026-04-03, Cron Trigger + cleanupExpiredAuthCodes + deleteExpiredDeviceCodes)
- [x] ~~既存テストの不備修正（services, users, admin テスト）~~ (2026-04-03, findUserByIdモック追加+mockResolvedValueOnceチェーンで全1286テストパス)
- [x] ~~Dependabot脆弱性アラート対応（picomatch ReDoS + Method Injection）~~ (2026-04-04, picomatch@4.0.4へアップデート + workers/mcp --passWithNoTests修正)
- [x] ~~authorization_code grantでID token発行（OIDC準拠）~~ (2026-04-04, signIdToken呼び出し追加)
- [x] ~~token exchangeのredirect_uri正規化~~ (2026-04-04, normalizeRedirectUri追加)
- [x] ~~/auth/loginのredirect_uri検証を/auth/authorizeと統一~~ (2026-04-04, matchRedirectUri方式に変更)
- [x] ~~isBffSessionのname空文字チェック追加~~ (2026-04-04)
- [x] ~~fetchWithAuthリフレッシュレスポンスバリデーション追加~~ (2026-04-04)
- [x] ~~MCPセッションTTLをスライディングウィンドウに変更~~ (2026-04-04, lastActiveAt追加)
- [x] ~~MCP list_usersのsearch OR検索対応~~ (2026-04-04, UserFilter.search + buildUserFilterClause)
- [x] ~~MCPセッションのインメモリ管理をD1永続化に変更~~ (2026-04-04, migration 0019 + mcp-sessions.ts + transport.ts書き換え)
- [x] ~~cleanupExpiredMcpSessionsテストのモック修正~~ (2026-04-04, scheduledハンドラテストでvi.mockのモック不備を修正)
- [x] ~~matchRedirectUri query string比較追加~~ (2026-04-04, localhostのポート無視しつつquery stringは厳密比較)
- [x] ~~matchRedirectUri localhost/127.0.0.1 混在対応~~ (2026-04-04, RFC 8252 §8.3 SHOULDに従い同一ホストとして扱う)
- [x] ~~introspect token_type_hint による検索順最適化~~ (2026-04-04, access_token ヒント時はJWT→リフレッシュの順に変更、ヘルパー関数に切り出しリファクタ)
