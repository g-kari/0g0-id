# ミドルウェアチェーン重複分析レポート

## 調査概要

- 対象ファイル: `workers/id/src/routes/users.ts` と `workers/id/src/routes/services.ts`
- 調査日時: 2026-04-11
- 検索パターン:
  1. `authMiddleware, rejectServiceTokenMiddleware`
  2. `authMiddleware, adminMiddleware`

## 結果サマリー

### 1. users.ts ファイルのミドルウェアチェーン

#### パターン1: authMiddleware + rejectServiceTokenMiddleware + rejectBannedUserMiddleware (18箇所)

このパターンは全て `/me` で始まるユーザー自身の操作エンドポイント：

- GET /me (行143)
- GET /me/data-export (行149)
- PATCH /me (行190 + csrfMiddleware)
- GET /me/connections (行217)
- GET /me/providers (行224)
- GET /me/login-history (行231)
- GET /me/login-stats (行251)
- GET /me/login-trends (行264)
- GET /me/security-summary (行276)
- DELETE /me/providers/:provider (行314 + csrfMiddleware)
- DELETE /me/connections/:serviceId (行342 + csrfMiddleware)
- GET /me/tokens (行353)
- DELETE /me/tokens/others (行360 + csrfMiddleware)
- DELETE /me/tokens/:tokenId (行371 + csrfMiddleware)
- DELETE /me/tokens (行382 + csrfMiddleware)
- DELETE /me (行390 + csrfMiddleware)

**重複度**: 高（18回の繰り返し）
**パターン内容**: 認証済みユーザーが自分のデータにアクセスする場合、サービストークンは拒否、BAN済みユーザーも拒否

#### パターン2: authMiddleware + adminMiddleware (15箇所 in users.ts)

このパターンは全て管理者専用エンドポイント：

- GET /:id (行402)
- GET /:id/owned-services (行412)
- GET /:id/services (行433)
- GET /:id/providers (行446)
- GET /:id/login-history (行459)
- GET /:id/login-stats (行484)
- GET /:id/login-trends (行503)
- PATCH /:id/role (行521 + csrfMiddleware)
- PATCH /:id/ban (行577 + csrfMiddleware)
- DELETE /:id/ban (行639 + csrfMiddleware)
- GET /:id/tokens (行683)
- DELETE /:id/tokens/:tokenId (行696 + csrfMiddleware)
- DELETE /:id/tokens (行743 + csrfMiddleware)
- DELETE /:id (行783 + csrfMiddleware)
- GET / (行819)

**重複度**: 高（15回の繰り返し）

### 2. services.ts ファイルのミドルウェアチェーン

#### パターン: authMiddleware + adminMiddleware (11箇所)

このパターンは全て管理者専用サービス管理エンドポイント：

- GET / (行83)
- GET /:id (行122)
- POST / (行149 + csrfMiddleware)
- PATCH /:id (行206 + csrfMiddleware)
- DELETE /:id (行259 + csrfMiddleware)
- GET /:id/redirect-uris (行311)
- POST /:id/redirect-uris (行332 + csrfMiddleware)
- POST /:id/rotate-secret (行384 + csrfMiddleware)
- PATCH /:id/owner (行436 + csrfMiddleware)
- GET /:id/users (行499)
- DELETE /:id/users/:userId (行543 + csrfMiddleware)
- DELETE /:id/redirect-uris/:uriId (行598 + csrfMiddleware)

**重複度**: 高（11回の繰り返し）

### 3. 他ルートファイルでの使用

#### authMiddleware + rejectServiceTokenMiddleware:

- auth.ts: 1箇所 (行1177 POST /link-intent)
- device.ts: インポートのみ

#### authMiddleware + adminMiddleware:

- admin-audit-logs.ts: 2箇所
- metrics.ts: 7箇所

## 重複パターン分析

### 重複の種類:

1. **高度な重複**: 同じミドルウェアの組み合わせが複数回出現
   - `authMiddleware + rejectServiceTokenMiddleware + rejectBannedUserMiddleware`: users.ts内で18回
   - `authMiddleware + adminMiddleware`: users.ts内で15回、services.ts内で11回、他ファイルで7回+2回

2. **CSRF中間層の追加パターン**:
   - データ変更操作（POST, PATCH, DELETE）には `csrfMiddleware` を追加
   - 読み取り操作（GET）には `csrfMiddleware` なし

### 重複度の定量化:

| パターン                                                                   | 出現数 | ファイル分布                                                            |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| authMiddleware + rejectServiceTokenMiddleware + rejectBannedUserMiddleware | 18     | users.ts + auth.ts(1)                                                   |
| authMiddleware + adminMiddleware                                           | 26     | users.ts(15) + services.ts(11) + metrics.ts(7) + admin-audit-logs.ts(2) |
| 上記パターン + csrfMiddleware                                              | 19     | 全ファイル                                                              |

### 全体的な重複率:

- **ミドルウェアチェーン重複**: 非常に高い
- ほぼ全てのエンドポイントが同じミドルウェア組み合わせを使用
- 重複パターンは機能分類で一貫性がある（自分のデータ vs 管理者機能）

## 推奨される改善案

1. **ミドルウェアスタック定義の共通化**: Hono の `app.use()` で共通スタックを事前適用
2. **ミドルウェアグループの定義**: 相互に関連するミドルウェアをグループ化（例: `userSelfMiddleware`, `adminMiddleware`）
3. **デコレータパターンの検討**: TypeScript/Hono でのルートグループ化
