# TODO

## セキュリティ / アーキテクチャ課題

### [高] MCPセッションのインメモリ管理がWorkerスケールアウトに非対応

- **場所**: `workers/mcp/src/mcp/transport.ts`
- **問題**: セッションIDが `Map` (インメモリ) に格納されており、Cloudflare Workersが複数インスタンスにスケールした場合、`initialize` を受けたインスタンスと後続リクエストを受けるインスタンスが異なると `Invalid or missing session` で全MCP呼び出しが失敗する
- **影響**: 本番環境でMCPが断続的に動作しなくなる可能性がある
- **対応案**:
  - D1にセッションを永続化する
  - Durable Objectsでセッション管理する
  - セッションIDをステートレス化する（JWTベースのセッショントークン等）

### [高] Dependabot脆弱性アラート（high 1件、moderate 1件）

- **場所**: https://github.com/g-kari/0g0-id/security/dependabot
- **問題**: 依存パッケージに既知の脆弱性が報告されている
- **対応案**: Dependabotの詳細を確認し、該当パッケージをアップデート

### ~~[中] 管理者ルートにBANチェックミドルウェアが未適用~~ ✅

- **対応済み**: `adminMiddleware` 内でDB問い合わせによるBANチェックを追加。全管理者ルートでBANされたユーザーのアクセスを即時遮断

### ~~[中] /auth/exchange と /auth/refresh が Service Bindings 保護なし~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`INTERNAL_SERVICE_SECRET` 環境変数による共有シークレット検証で、BFF以外の外部からの直接呼び出しをブロック。サービスOAuth（Basic認証）は引き続き許可

### ~~[低] /auth/logout が認証なしでアクセス可能~~ ✅

- **対応済み**: `serviceBindingMiddleware` を追加。`/auth/exchange` や `/auth/refresh` と同様に、BFF以外の外部からの直接呼び出しをブロック

### ~~[低] Device Code Grant の user_code ブルートフォース耐性~~ ✅

- **対応済み**: 認証ユーザー単位のレートリミッター `RATE_LIMITER_DEVICE_VERIFY` を追加（10回/分/ユーザー）。既存のIP単位レートリミット（30回/分）と二重防御でブルートフォースを緩和

### [情報] matchRedirectUri の localhost/127.0.0.1 混在

- **場所**: `packages/shared/src/lib/redirect-uri.ts` (L9-33)
- **問題**: `isLocalhostHost`は`localhost`と`127.0.0.1`の両方を認識するが、後続のhostname比較で不一致になる。セキュリティ上は安全側だが、localhostで登録して127.0.0.1でリクエストした場合にユーザー体験が悪化する可能性
- **対応案**: 両方のhostnameをlocalhostとして統一するか、ドキュメントで明記

### ~~[低] Device Code Grant: approved_at / user_id のデータ不整合エッジケース~~ ✅

- **対応済み**: DB CHECK制約 `CHECK (approved_at IS NULL OR user_id IS NOT NULL)` を追加（migration 0018）

## 完了済み

- [x] ~~MCPミドルウェアのBAN/Adminチェック順序修正~~ (2026-04-03, commit 9575641)
- [x] ~~Device Code Grant: approved_at/user_id 不整合防止のCHECK制約追加~~ (2026-04-03, migration 0018)
- [x] ~~管理者ルートにBANチェック追加~~ (2026-04-03, adminMiddleware内でDB確認)
- [x] ~~/auth/exchange, /auth/refresh にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware + INTERNAL_SERVICE_SECRET)
- [x] ~~/auth/logout にService Bindings保護追加~~ (2026-04-03, serviceBindingMiddleware適用)
- [x] ~~Device Code user_code ブルートフォース耐性強化~~ (2026-04-03, 認証ユーザー単位レートリミッター追加)
