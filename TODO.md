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

### [中] /auth/exchange と /auth/refresh が Service Bindings 保護なし

- **場所**: `workers/id/src/routes/auth.ts` (L933, L1061)
- **問題**: BFF向けトークン交換エンドポイントが外部から直接HTTPリクエストで呼び出し可能。Service Bindings経由であることを検証するミドルウェアがない
- **影響**: 認可コードを窃取できた攻撃者が直接エンドポイントを呼び出し可能（ただし認可コードは1分有効期限+SHA-256+一度きり消費で保護されており攻撃難易度は高い）
- **対応案**: Service Bindings経由の呼び出しを検証するミドルウェア（特定ヘッダーやシークレット検証）の追加

### [低] /auth/logout が認証なしでアクセス可能

- **場所**: `workers/id/src/routes/auth.ts` (L1186)
- **問題**: リフレッシュトークンの値を知っていれば認証なしで他ユーザーのセッションを失効可能
- **影響**: リフレッシュトークンの秘匿性が前提のため現実的リスクは低いが、defense-in-depthの観点では認証追加が望ましい
- **対応案**: アクセストークン認証の追加

### [低] Device Code Grant の user_code ブルートフォース耐性

- **場所**: `workers/id/src/routes/device.ts` (L176-253)
- **問題**: user_codeは8文字(31種類)≒約8.5億パターン。試行失敗回数の追跡メカニズムがなく、大量の不正試行を検知する手段がない
- **対応案**: user_code試行失敗回数カウント+一定回数超過時のdevice_code自動失効、またはuser_code長の拡張

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
