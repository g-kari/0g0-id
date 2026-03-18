---
paths:
  - "workers/**/*.ts"
  - "packages/shared/**/*.ts"
---

# API設計規約

## レスポンス形式

### 成功レスポンス
```json
{ "data": { ... } }
```

### エラーレスポンス
```json
{ "error": { "code": "ERROR_CODE", "message": "説明" } }
```

## HTTPステータスコード
- 200: 成功（GET, PATCH）
- 201: 作成成功（POST）
- 204: 削除成功（DELETE）
- 400: バリデーションエラー
- 401: 未認証
- 403: 権限不足
- 404: リソース未検出
- 409: 競合（重複登録など）
- 500: サーバーエラー

## id.0g0.xyz エンドポイント一覧
| パス | メソッド | 認証 | 説明 |
|------|----------|------|------|
| /api/health | GET | Public | ヘルスチェック |
| /auth/login | GET | Public | Google認可へリダイレクト |
| /auth/callback | GET | Public | Googleコールバック |
| /auth/exchange | POST | Service Bindings | ワンタイムコード交換 |
| /auth/logout | POST | Service Bindings | ログアウト |
| /auth/refresh | POST | Service Bindings | トークンリフレッシュ |
| /.well-known/jwks.json | GET | Public | JWKS公開鍵 |
| /api/users/me | GET/PATCH | JWT | 自ユーザー情報 |
| /api/users | GET | JWT+Admin | ユーザー一覧 |
| /api/token/introspect | POST | Basic認証 | トークンイントロスペクション |
| /api/services | GET/POST | JWT+Admin | サービス管理 |
| /api/services/:id | DELETE | JWT+Admin | サービス削除 |
| /api/services/:id/redirect-uris | GET/POST/DELETE | JWT+Admin | redirect_uri管理 |
