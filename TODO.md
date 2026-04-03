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

### [中] 管理者ルートにBANチェックミドルウェアが未適用

- **場所**: `workers/id/src/routes/users.ts`, `services.ts`, `metrics.ts`, `admin-audit-logs.ts`
- **問題**: 管理者ルートで `authMiddleware` + `adminMiddleware` は適用されているが、`rejectBannedUserMiddleware` が含まれていない。BANされた管理者がJWT有効期限（15分）内に管理操作を継続できる
- **影響**: 管理者がBANされた場合、即座にアクセスを遮断できない（最大15分の猶予が発生）
- **対応案**: 管理者ルートに `rejectBannedUserMiddleware` を追加するか、`adminMiddleware` 内でDB確認を行う

### ~~[低] Device Code Grant: approved_at / user_id のデータ不整合エッジケース~~ ✅

- **対応済み**: DB CHECK制約 `CHECK (approved_at IS NULL OR user_id IS NOT NULL)` を追加（migration 0018）

## 完了済み

- [x] ~~MCPミドルウェアのBAN/Adminチェック順序修正~~ (2026-04-03, commit 9575641)
- [x] ~~Device Code Grant: approved_at/user_id 不整合防止のCHECK制約追加~~ (2026-04-03, migration 0018)
