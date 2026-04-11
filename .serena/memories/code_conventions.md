---
name: code_conventions
description: コード規約・スタイル・設計パターン
type: project
---

## コード規約

### 全般

- TypeScript strict mode
- コメント・コミットメッセージは日本語
- zod でリクエストバリデーション
- エラー形式: `{ error: { code: string, message: string } }`
- 成功形式: `{ data: ... }` または `{ data: ..., meta: { total, limit, offset } }`

### DB関数（packages/shared/src/db/）

- 関数ごとにファイルを分割（login-events.ts, users.ts等）
- D1Database を第一引数で受け取る
- 日時はISO文字列（`.toISOString()`）で保存・比較
- インターフェース定義はDBファイル内に記述

### Honoルート（workers/\*/src/routes/）

- 1ルートファイルにHonoアプリ1個
- `app.route(...)` でindex.tsに集約
- middleware: authMiddleware（JWT検証）, adminMiddleware（admin権限チェック）
- レートリミット: authRateLimitMiddleware, tokenApiRateLimitMiddleware, externalApiRateLimitMiddleware

### ヘルパー利用（packages/shared/src/lib/pagination.ts）

- `parsePagination()` → limit/offset パース・バリデーション
- `parseDays()` → days クエリパラメータのパース（1-90、デフォルトなし）

### BFF（user/admin workers）

- IdPへはService Bindings経由またはfetchWithAuth/fetchWithJsonBody
- セッションはCookieで管理
- proxyResponse / proxyMutate でIdPレスポンスをそのまま転送
