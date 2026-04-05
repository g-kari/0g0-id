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

### ~~[高] PKCE が `token.ts` の authorization_code グラントで任意~~ ✅

- **対応済み**: `handleAuthorizationCodeGrant` で `code_challenge` が DB に保存されている場合のみ検証し、コンフィデンシャルクライアント以外（パブリッククライアント）では PKCE を必須化。`code_challenge` なしのリクエストはパブリッククライアントからの場合にエラーを返すよう修正（RFC 7636 §4.4 準拠）

### ~~[高] `/api/token` エンドポイントのレートリミットが IP 単位のみ~~ ✅

- **対応済み**: `RATE_LIMITER_TOKEN` を `client_id` キーでも設定し、IP 単位と二重防御

### ~~[高] `unrevokeRefreshToken` の競合状態~~ ✅

- **対応済み**: `token.ts` のサービス所有権確認・有効期限チェックのパスで `unrevokeRefreshToken` 呼び出し前に `findRefreshTokenByHash` で現在の `revoked_reason` を確認し、`reuse_detected` が設定済みの場合はアンリボークせず `Token reuse detected` を返すよう修正。`auth.ts` の catch ブロックと同様のパターンを追加。テスト2件追加（2026-04-05）

### ~~[中] RFC 7009 (Token Revocation) — アクセストークンの revoke が実装済み~~ ✅

- **対応済み**: `revoked_access_tokens` テーブル（D1）に `jti` を保存し、`introspect` で参照
- migration: `0020_revoked_access_tokens.sql`（⚠️ 本番DB適用要: `npm run migrate:id`）

### ~~[中] `resolveEffectiveScope`: スコープ未指定時に全 allowedScopes を付与~~ ✅

- **対応済み**: スコープ未指定時は `'openid'` のみを返すよう修正（最小スコープポリシー、RFC 6749 §3.3 準拠）。`scopes.test.ts` を新規作成し 14テストを追加（2026-04-05）

### ~~[中] `mcp_sessions` テーブルにユーザーIDが関連付けられていない~~ ✅

- **対応済み**: migration 0021: `user_id` カラム追加、`createMcpSession`/`deleteMcpSessionsByUser` 更新（2026-04-05）

### ~~[中] authMiddlewareにJTIブロックリストチェックが未追加~~ ✅

- **対応済み**: `authMiddleware` で `isAccessTokenRevoked` を呼び出し、revokeされたアクセストークンを即時拒否するよう修正（2026-04-05）

### ~~[中] `isAccessTokenRevoked`: 期限切れレコードを除外するフィルター未適用~~ ✅

- **対応済み**: `expires_at` フィルターを追加し、期限切れのJTIレコードを除外してクエリ効率を改善（2026-04-05）

### ~~[低] 期限切れJTIエントリの定期削除が未実装~~ ✅

- **対応済み**: `cleanupExpiredRevokedAccessTokens` を実装し、scheduledハンドラー（Cron Trigger）に追加。期限切れエントリを自動削除（2026-04-05）

## 未対応課題

### ~~[中] introspect時のスコープフォールバック不整合~~ ✅

- **対応済み**: `introspectRefreshToken` / `introspectJwtToken` から `parseAllowedScopes` フォールバックを削除。スコープが null の場合は空文字列を返すよう修正（RFC 7662 §2.2 準拠）。リフレッシュトークンの introspect レスポンスに `token_type: 'refresh_token'` を追加（2026-04-05）

### ~~[中] パブリッククライアントの `client_id` 単位レートリミット欠如~~ ✅

- **対応済み**: `tokenApiClientRateLimitMiddleware` の `getKey` を async 化し、`Authorization: Basic` ヘッダーがない場合はリクエストボディ（urlencoded / JSON両対応）から `client_id` を取得するよう修正。Honoのボディキャッシュ機構により二重読み取りが安全。テスト7件追加（2026-04-05）

### ~~[低] `unrevokeRefreshToken` 失敗時のエラーハンドリング不足~~ ✅

- **対応済み**: リトライ付き（最大2回）のエラーハンドリングを実装。戻り値を boolean に変更し、呼び出し箇所を try-catch で囲んでログ記録。

### ~~[低] `X-Forwarded-For` スプーフィングリスク~~ ✅

- **対応済み**: `getClientIp` から `x-forwarded-for` フォールバックを削除。`cf-connecting-ip` が未設定の場合は `null` を返すよう修正。ローカル開発・Cloudflare設定ミス時はすべてのリクエストが `'unknown'` キーを共有し、`x-forwarded-for` 偽装によるレートリミット回避を防止（2026-04-05）

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
- [x] ~~PKCE が authorization_code グラントで任意（パブリッククライアントで必須化）~~ (2026-04-04, handleAuthorizationCodeGrant でパブリッククライアントへの PKCE 必須化、RFC 7636 §4.4 準拠)
- [x] ~~authMiddlewareにJTIブロックリストチェック追加~~ (2026-04-05, revokeされたアクセストークンを即時拒否)
- [x] ~~isAccessTokenRevoked: expires_atフィルター追加~~ (2026-04-05, 期限切れレコードを除外してクエリ効率改善)
- [x] ~~cleanupExpiredRevokedAccessTokens: 期限切れJTIエントリ定期削除~~ (2026-04-05, scheduledハンドラーに追加)
- [x] ~~well-known: openid-configuration の token_endpoint が /auth/exchange（BFF内部用）を誤って指定~~ (2026-04-05, /api/token に修正・RFC 6749準拠)
- [x] ~~well-known: openid-configuration に device_authorization_endpoint が欠落~~ (2026-04-05, 追加・RFC 8628準拠)
- [x] ~~well-known: openid-configuration に end_session_endpoint が欠落~~ (2026-04-05, 追加・OIDC RP-Initiated Logout準拠)
- [x] ~~well-known: oauth-authorization-server に未実装の registration_endpoint が宣言されていた~~ (2026-04-05, 削除)
- [x] ~~introspect: リフレッシュトークン・JWTトークンのレスポンスに iss・iat が欠落~~ (2026-04-05, 追加・RFC 7662 §2.2準拠)
- [x] ~~期限切れ・失効済みリフレッシュトークンの自動クリーンアップが未実装~~ (2026-04-05, deleteExpiredRefreshTokens + scheduledハンドラーに追加)

## コードレビュー対応済み（2026-04-05）

### セキュリティ修正: unrevokeRefreshToken エラーハンドリング改善

- ✅ `token.ts` / `auth.ts` の `throw e` を RFC 6749 §5.2 準拠の `server_error` JSON レスポンスに変更
- ✅ `unrevokeRefreshToken` の戻り値チェックを追加（`false` 時に `console.error` でログ出力）
- 並行処理でトークン失効解除が失敗した場合の追跡可能性を改善

## リファクタリング対応済み（2026-04-05）

### コード共通化: unrevokeRefreshToken try/catch の共通ユーティリティ抽出

- ✅ `workers/id/src/utils/token-recovery.ts` に `attemptUnrevokeToken(db, tokenId, context)` を新設
- ✅ `token.ts` の3箇所・`auth.ts` の2箇所の重複 try/catch ブロックを `attemptUnrevokeToken` 呼び出しに置換
- メンテナンス性向上・ログ出力の一貫性確保

## コードレビュー対応 (2026-04-05)

### 対応済み ✅
- **期限切れトークンの `attemptUnrevokeToken` 削除** (`token.ts`)
  - 期限切れチェック後に `attemptUnrevokeToken` を呼んで rotation 状態を解除していたが不要かつ危険
  - 期限切れトークンを revoked_at=NULL に戻すと reuse detection ロジックが誤動作するリスク
  - 該当行を削除し、期限切れは `invalid_grant` をそのまま返す挙動に統一

- **`introspectRefreshToken` 失効チェック改善** (`token.ts`)
  - `!refreshToken || revoked_at !== null` を1行で null 返しにしていたのを分離
  - 失効済みトークン（存在はするが revoked）は `{ active: false }` を返すよう修正
  - 「見つからない」と「失効済み」を区別し RFC 7662 §2.2 に準拠
