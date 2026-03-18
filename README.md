# 0g0-id

統合ID基盤（IdP）モノレポ — Google OAuth ラッパー + サービス管理基盤

**Hono + Cloudflare Workers + D1** で構築した軽量な認証基盤です。

## 構成

```
id.0g0.xyz    — IdP コアAPI（認証・JWT・サービス管理）
user.0g0.xyz  — ユーザー向け画面（ログイン・プロフィール）
admin.0g0.xyz — 管理画面（サービス管理・ユーザー管理）
```

```
0g0-id/
├── packages/shared/     # 共通ライブラリ（型定義・JWT・DB操作）
├── workers/
│   ├── id/              # IdP コアAPI
│   ├── user/            # ユーザー向け BFF
│   └── admin/           # 管理画面 BFF
└── migrations/          # D1 スキーマ
```

## 技術スタック

- **Hono** — Webフレームワーク
- **Cloudflare Workers** — エッジランタイム
- **Cloudflare D1** — SQLiteベースDB
- **jose** — ES256 JWT（WebCrypto）
- **Service Bindings** — Worker間通信（ネットワーク経由なし）

## セキュリティ設計

| 項目 | 実装 |
|---|---|
| JWT署名 | ES256 + JWKS（`kid` 付き） |
| OAuth | state + PKCE (S256) 必須 |
| Cookie | `__Host-` prefix / `HttpOnly` / `Secure` / `SameSite=Lax` |
| CSRF | Origin ヘッダー検証 |
| リフレッシュトークン | ローテーション + reuse detection（family 全失効） |
| 管理者権限 | DB ロールベース + 初回ブートストラップ |

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. D1 データベース作成

```bash
wrangler d1 create 0g0-id-db
# 出力された database_id を workers/id/wrangler.toml に設定
```

### 3. マイグレーション実行

```bash
cd workers/id
npx wrangler d1 execute 0g0-id-db --remote --file=../../migrations/0001_initial.sql
```

### 4. ES256 鍵ペア生成

```bash
openssl ecparam -genkey -name prime256v1 -noout -out private.pem
openssl ec -in private.pem -pubout -out public.pem
```

### 5. シークレット設定

```bash
cd workers/id
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put JWT_PRIVATE_KEY      # private.pem の内容
npx wrangler secret put JWT_PUBLIC_KEY       # public.pem の内容
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

### 6. デプロイ

```bash
npm run deploy:id
npm run deploy:user
npm run deploy:admin
```

## 開発

```bash
npm run dev:id     # :8787
npm run dev:user   # :8788
npm run dev:admin  # :8789
npm run typecheck  # 全ワークスペース型チェック
```

ローカル開発時は `workers/id/.dev.vars` にシークレットを記載します（`.gitignore` 済み）:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
JWT_PRIVATE_KEY=...
JWT_PUBLIC_KEY=...
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
```

## 認証フロー

```
ブラウザ → user.0g0.xyz/auth/login
  → state + PKCE 生成 → Cookie 保存
  → id.0g0.xyz/auth/login → Google 認可画面
  → id.0g0.xyz/auth/callback（Google コード受取）
  → ワンタイム認可コード発行
  → user.0g0.xyz/auth/callback
  → id への内部 API（Service Bindings）でコード交換
  → __Host- Cookie にトークン設定
```

## API

`/.well-known/jwks.json` で ES256 公開鍵を公開しています。各サービスはこの JWKS を取得してローカルで JWT を検証できます。

詳細なエンドポイント一覧は [.claude/rules/api.md](.claude/rules/api.md) を参照してください。

## Cloudflare / GitHub 接続設定

[docs/cloudflare-github-setup.md](docs/cloudflare-github-setup.md) を参照してください。
