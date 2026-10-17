# 静的アセット生成・鍵ローテーション

id Worker の JWKS / OIDC Discovery / OpenAPI は **ビルド時に静的ファイルとして生成**し、Cloudflare Workers Assets でエッジ配信する。

---

## 生成されるファイル

| パス                                          | 内容                                | キャッシュ TTL |
| --------------------------------------------- | ----------------------------------- | -------------- |
| `dist/.well-known/jwks.json`                  | ES256 公開鍵（JWKS 形式）           | 1 時間         |
| `dist/.well-known/openid-configuration`       | OIDC Discovery Document             | 24 時間        |
| `dist/.well-known/oauth-authorization-server` | OAuth Authorization Server Metadata | 24 時間        |
| `dist/docs/openapi.json`                      | 内部 OpenAPI 仕様                   | 1 時間         |
| `dist/docs/external/openapi.json`             | 外部連携 OpenAPI 仕様               | 1 時間         |
| `dist/_headers`                               | Cloudflare キャッシュ制御ヘッダー   | —              |

---

## 生成フロー

`npm run deploy:id` の内部で以下の順序で実行される:

```
preflight → D1 migrate → vp build → build:assets → wrangler deploy
                                      ↑ ここで生成
```

### build:assets の処理

1. **公開鍵の解決**（優先順位）
   1. `JWT_PUBLIC_KEY` 環境変数（PEM 形式）— 鍵ローテーション時
   2. `workers/id/public-key.jwk.json`（JWK 形式）— 通常ビルド
2. **JWKS 生成**: PEM/JWK → JWKS 形式に変換（`kid` は SHA-256 ハッシュから算出）
3. **OIDC メタデータ生成**: `buildOpenIdConfiguration()` で各エンドポイント URL を組み立て
4. **OpenAPI 仕様生成**: 内部 API / 外部 API の 2 種類を出力
5. **`dist/` に全ファイルを書き出し**

---

## Workers Assets 配信設定

`workers/id/wrangler.toml`:

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = [
  "/*",
  "!/.well-known/jwks.json",
  "!/.well-known/openid-configuration",
  "!/.well-known/oauth-authorization-server",
  "!/docs/openapi.json",
  "!/docs/external/openapi.json",
]
```

- `/*` → デフォルトは Worker が処理
- `!` プレフィックス → Assets が直接配信（Worker を経由しない = レイテンシ最小）

---

## 鍵ローテーション手順

### 1. 新しい ES256 鍵ペアを生成

```bash
openssl ecparam -genkey -name prime256v1 -noout -out private-new.pem
openssl ec -in private-new.pem -pubout -out public-new.pem
```

### 2. Worker シークレットを更新

```bash
cd workers/id
npx wrangler secret put JWT_PRIVATE_KEY < private-new.pem
npx wrangler secret put JWT_PUBLIC_KEY < public-new.pem
```

### 3. 新しい公開鍵でデプロイ

```bash
export JWT_PUBLIC_KEY="$(cat public-new.pem)"
npm run deploy:id
```

### 4. コミットされた JWK ファイルを更新

`workers/id/public-key.jwk.json` を新しい公開鍵の JWK に差し替えてコミットする。

> ⚠️ **Step 2〜4 はすべて実施すること。** Worker シークレットだけ更新してファイルを更新しないと、次回の（環境変数なしの）ビルドで JWKS が旧鍵に戻り、外部サービスの JWT 検証が失敗する。

---

## ランタイムとビルド時の鍵使用

| フェーズ   | 鍵ソース                                      | 用途                              | 形式       |
| ---------- | --------------------------------------------- | --------------------------------- | ---------- |
| ビルド時   | `JWT_PUBLIC_KEY` env or `public-key.jwk.json` | `dist/.well-known/jwks.json` 生成 | PEM or JWK |
| ランタイム | `c.env.JWT_PUBLIC_KEY` シークレット           | JWT 署名検証                      | PEM        |
| エッジ配信 | `dist/.well-known/jwks.json`                  | クライアントが取得                | JWKS       |

---

## 関連ファイル

| ファイル                                   | 説明                        |
| ------------------------------------------ | --------------------------- |
| `workers/id/scripts/build-assets.ts`       | アセット生成スクリプト      |
| `workers/id/public-key.jwk.json`           | コミットされた公開鍵（JWK） |
| `packages/shared/src/lib/oidc-metadata.ts` | OIDC メタデータビルダー     |
| `workers/id/wrangler.toml`                 | Assets 配信設定             |
