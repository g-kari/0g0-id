# 環境変数一覧

各 Worker で使用する環境変数（`[vars]`）とシークレットの一覧。
シークレットの設定手順は [deployment.md](./deployment.md) を参照。

---

## id Worker（id.0g0.xyz）

### 環境変数（wrangler.toml `[vars]`）

| 変数名         | 値（例）                | 説明                                  |
| -------------- | ----------------------- | ------------------------------------- |
| `IDP_ORIGIN`   | `https://id.0g0.xyz`    | IdP 自身のオリジン                    |
| `USER_ORIGIN`  | `https://user.0g0.xyz`  | user BFF のオリジン（リダイレクト先） |
| `ADMIN_ORIGIN` | `https://admin.0g0.xyz` | admin BFF のオリジン                  |

### シークレット（`wrangler secret put`）

| シークレット名                  | 用途                                       | 必須 | preflight 検査 |
| ------------------------------- | ------------------------------------------ | :--: | :------------: |
| `GOOGLE_CLIENT_ID`              | Google OAuth クライアント ID               |  ✅  |       —        |
| `GOOGLE_CLIENT_SECRET`          | Google OAuth クライアントシークレット      |  ✅  |       —        |
| `LINE_CLIENT_ID`                | LINE OAuth クライアント ID                 |  —   |       —        |
| `LINE_CLIENT_SECRET`            | LINE OAuth クライアントシークレット        |  —   |       —        |
| `TWITCH_CLIENT_ID`              | Twitch OAuth クライアント ID               |  —   |       —        |
| `TWITCH_CLIENT_SECRET`          | Twitch OAuth クライアントシークレット      |  —   |       —        |
| `GITHUB_CLIENT_ID`              | GitHub OAuth クライアント ID               |  —   |       —        |
| `GITHUB_CLIENT_SECRET`          | GitHub OAuth クライアントシークレット      |  —   |       —        |
| `X_CLIENT_ID`                   | X (Twitter) OAuth クライアント ID          |  —   |       —        |
| `X_CLIENT_SECRET`               | X (Twitter) OAuth クライアントシークレット |  —   |       —        |
| `JWT_PRIVATE_KEY`               | ES256 署名用秘密鍵（PEM）                  |  ✅  |       —        |
| `JWT_PUBLIC_KEY`                | ES256 検証用公開鍵（PEM）                  |  ✅  |       —        |
| `COOKIE_SECRET`                 | state/PKCE Cookie 署名鍵                   |  ✅  |       —        |
| `BOOTSTRAP_ADMIN_EMAIL`         | 初回管理者のメールアドレス                 |  ✅  |       —        |
| `INTERNAL_SERVICE_SECRET_USER`  | user BFF との Service Binding 認証用       |  ✅  |       ✅       |
| `INTERNAL_SERVICE_SECRET_ADMIN` | admin BFF との Service Binding 認証用      |  ✅  |       ✅       |
| `EXTRA_BFF_ORIGINS`             | 追加 BFF オリジン（カンマ区切り）          |  —   |       —        |

> ⚠️ OAuth プロバイダー（LINE / Twitch / GitHub / X）は `CLIENT_ID` と `CLIENT_SECRET` のペアで設定すること。片方だけの設定はバリデーションエラーになる。

### Bindings

| 名前                         | 種類           | 説明                                                |
| ---------------------------- | -------------- | --------------------------------------------------- |
| `DB`                         | D1 Database    | メインデータベース                                  |
| `ASSETS`                     | Workers Assets | 静的アセット配信（JWKS / OIDC Discovery / OpenAPI） |
| `RATE_LIMITER_AUTH`          | Rate Limiting  | 認証エンドポイント用（namespace_id: 1001）          |
| `RATE_LIMITER_EXTERNAL`      | Rate Limiting  | 外部 API 用（namespace_id: 1002）                   |
| `RATE_LIMITER_TOKEN`         | Rate Limiting  | トークンエンドポイント用（namespace_id: 1003）      |
| `RATE_LIMITER_DEVICE_VERIFY` | Rate Limiting  | DBSC デバイス検証用（namespace_id: 1004）           |
| `RATE_LIMITER_TOKEN_CLIENT`  | Rate Limiting  | クライアント別トークン用（namespace_id: 1005）      |

---

## user Worker（user.0g0.xyz）

### 環境変数（wrangler.toml `[vars]`）

| 変数名        | 値（例）               | 説明           |
| ------------- | ---------------------- | -------------- |
| `IDP_ORIGIN`  | `https://id.0g0.xyz`   | IdP のオリジン |
| `SELF_ORIGIN` | `https://user.0g0.xyz` | 自身のオリジン |

### シークレット（`wrangler secret put`）

| シークレット名                 | 用途                                        | 必須 | preflight 検査 |
| ------------------------------ | ------------------------------------------- | :--: | :------------: |
| `SESSION_SECRET`               | セッション Cookie 署名鍵                    |  ✅  |       —        |
| `INTERNAL_SERVICE_SECRET_SELF` | id Worker への Service Binding 認証トークン |  ✅  |       —        |
| `DBSC_ENFORCE_SENSITIVE`       | DBSC 強制モード（`"true"` で有効）          |  —   |       ✅       |

> ⚠️ `INTERNAL_SERVICE_SECRET_SELF` は id Worker の `INTERNAL_SERVICE_SECRET_USER` と同じ値を設定すること。

### Bindings

| 名前     | 種類            | 説明                     |
| -------- | --------------- | ------------------------ |
| `IDP`    | Service Binding | id Worker への内部通信   |
| `ASSETS` | Workers Assets  | Astro フロントエンド配信 |

---

## admin Worker（admin.0g0.xyz）

### 環境変数（wrangler.toml `[vars]`）

| 変数名        | 値（例）                | 説明           |
| ------------- | ----------------------- | -------------- |
| `IDP_ORIGIN`  | `https://id.0g0.xyz`    | IdP のオリジン |
| `SELF_ORIGIN` | `https://admin.0g0.xyz` | 自身のオリジン |

### シークレット（`wrangler secret put`）

| シークレット名                 | 用途                                        | 必須 | preflight 検査 |
| ------------------------------ | ------------------------------------------- | :--: | :------------: |
| `SESSION_SECRET`               | セッション Cookie 署名鍵                    |  ✅  |       —        |
| `INTERNAL_SERVICE_SECRET_SELF` | id Worker への Service Binding 認証トークン |  ✅  |       —        |
| `DBSC_ENFORCE_SENSITIVE`       | DBSC 強制モード（`"true"` で有効）          |  —   |       ✅       |

> ⚠️ `INTERNAL_SERVICE_SECRET_SELF` は id Worker の `INTERNAL_SERVICE_SECRET_ADMIN` と同じ値を設定すること。

### Bindings

| 名前     | 種類            | 説明                     |
| -------- | --------------- | ------------------------ |
| `IDP`    | Service Binding | id Worker への内部通信   |
| `ASSETS` | Workers Assets  | Astro フロントエンド配信 |

---

## mcp Worker（mcp.0g0.xyz）

### 環境変数（wrangler.toml `[vars]`）

| 変数名       | 値（例）              | 説明           |
| ------------ | --------------------- | -------------- |
| `IDP_ORIGIN` | `https://id.0g0.xyz`  | IdP のオリジン |
| `MCP_ORIGIN` | `https://mcp.0g0.xyz` | 自身のオリジン |

### シークレット

なし（認証は id Worker への Service Binding で行う）。

### Bindings

| 名前               | 種類            | 説明                                       |
| ------------------ | --------------- | ------------------------------------------ |
| `IDP`              | Service Binding | id Worker への内部通信                     |
| `DB`               | D1 Database     | メインデータベース                         |
| `RATE_LIMITER_MCP` | Rate Limiting   | MCP エンドポイント用（namespace_id: 1010） |

---

## Service Binding シークレットの対応関係

Worker 間の Service Binding 認証では、**送信側と受信側で同一の値を設定する必要がある**。

| 送信側（BFF） | 送信側シークレット             | 受信側（id） | 受信側シークレット              |
| ------------- | ------------------------------ | ------------ | ------------------------------- |
| user Worker   | `INTERNAL_SERVICE_SECRET_SELF` | id Worker    | `INTERNAL_SERVICE_SECRET_USER`  |
| admin Worker  | `INTERNAL_SERVICE_SECRET_SELF` | id Worker    | `INTERNAL_SERVICE_SECRET_ADMIN` |

値が不一致の場合、該当 BFF からの全リクエストが 403 で失敗する。
