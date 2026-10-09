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

| シークレット名                  | 用途                                       |   必須   | preflight 検査 |
| ------------------------------- | ------------------------------------------ | :------: | :------------: |
| `GOOGLE_CLIENT_ID`              | Google OAuth クライアント ID               |    ✅    |       —        |
| `GOOGLE_CLIENT_SECRET`          | Google OAuth クライアントシークレット      |    ✅    |       —        |
| `LINE_CLIENT_ID`                | LINE OAuth クライアント ID                 |    —     |       —        |
| `LINE_CLIENT_SECRET`            | LINE OAuth クライアントシークレット        |    —     |       —        |
| `TWITCH_CLIENT_ID`              | Twitch OAuth クライアント ID               |    —     |       —        |
| `TWITCH_CLIENT_SECRET`          | Twitch OAuth クライアントシークレット      |    —     |       —        |
| `GITHUB_CLIENT_ID`              | GitHub OAuth クライアント ID               |    —     |       —        |
| `GITHUB_CLIENT_SECRET`          | GitHub OAuth クライアントシークレット      |    —     |       —        |
| `X_CLIENT_ID`                   | X (Twitter) OAuth クライアント ID          |    —     |       —        |
| `X_CLIENT_SECRET`               | X (Twitter) OAuth クライアントシークレット |    —     |       —        |
| `JWT_PRIVATE_KEY`               | ES256 署名用秘密鍵（PEM）                  |    ✅    |       —        |
| `JWT_PUBLIC_KEY`                | ES256 検証用公開鍵（PEM）                  |    ✅    |       —        |
| `COOKIE_SECRET`                 | state/PKCE Cookie 署名鍵                   |    ✅    |       —        |
| `BOOTSTRAP_ADMIN_EMAIL`         | 初回管理者作成用（確認後に削除）           | 初回のみ |       —        |
| `INTERNAL_SERVICE_SECRET_USER`  | user BFF との Service Binding 認証用       |    ✅    |       ✅       |
| `INTERNAL_SERVICE_SECRET_ADMIN` | admin BFF との Service Binding 認証用      |    ✅    |       ✅       |
| `EXTRA_BFF_ORIGINS`             | 追加 BFF オリジン（カンマ区切り）          |    —     |       —        |

> ⚠️ OAuth プロバイダー（LINE / Twitch / GitHub / X）は `CLIENT_ID` と `CLIENT_SECRET` のペアで設定すること。片方だけの設定はバリデーションエラーになる。

### 初回管理者の作成後

`BOOTSTRAP_ADMIN_EMAIL` は初回作成用で、恒常的な管理者許可リストではありません。
OAuth コールバックでユーザーのメールアドレスが大文字小文字を除いて一致し、
そのユーザーが非管理者かつ DB 内の管理者が 0 人の場合にのみ、原子的に `role = 'admin'` を付与します。
初回完了を記録して設定を自動無効化する仕組みはないため、設定を残して管理者が再び 0 人になると、
一致するアカウントのログイン時に再付与される可能性があります。

**初回管理者を作成し、管理者として利用できることを確認したら、この設定を削除してください。**

1. 意図したアカウントで初回ログインし、管理者ロールが保存されたことを確認します。
   管理画面に新しくログインし、管理者専用のユーザー一覧またはサービス一覧を正常に読み取れることも確認します。
   作成・アクセスの確認ができない場合は削除を進めず、原因を調べてください。
2. 対象の Cloudflare アカウント、id Worker（通常 `0g0-id`）、環境を確認します。
   下のコマンドは既定環境用です。別環境を運用している場合は、その設定と環境を明示してください。
3. id Worker の `BOOTSTRAP_ADMIN_EMAIL` だけを削除します。既存管理者の権限は DB の
   `users.role` で保持されるため、この設定の削除は既存ロールを降格させません。
   通常の OAuth ログインにもこの設定は必須ではありません。

   ```bash
   cd workers/id
   vp exec wrangler secret delete BOOTSTRAP_ADMIN_EMAIL
   vp exec wrangler secret list
   ```

   `secret list` は値を表示せず、削除した名前が一覧にないことを確認できます。
   **`secret delete` は新しい Worker バージョンを作成して即時デプロイします。**
   段階デプロイ中はこのコマンドを使わず、[Cloudflare のバージョン別シークレット手順](https://developers.cloudflare.com/workers/configuration/secrets/#delete-secrets-from-your-project)
   に従い、未設定のバージョンが対象トラフィックへ反映されたことまで確認してください。

4. ローカルの `.dev.vars` / `.env`、Wrangler の `[vars]`、CI のシークレット投入元などに
   同じ設定がある場合も除き、次の起動・デプロイ・ロールバックで再投入しないようにします。
   それぞれ対象の環境だけを扱い、他のシークレットやユーザーデータは変更しません。
5. 削除の反映後、既存管理者で改めてログインし、管理者専用の一覧を正常に読み取れることを確認します。
   名前の削除確認だけでは、実際の管理者ログインが成功したことにはなりません。

削除後にすべての管理者を失った場合は、自動ブートストラップによる復旧は行われません。
再設定は意図したアカウントと対象環境を確認したうえで行う明示的な権限復旧作業として扱い、
恒常的に残さず、復旧確認後に再び削除してください。設定の削除・再設定は運用者が別途実施します。
実装根拠は [OAuth コールバック](../workers/id/src/routes/auth/callback.ts)、
[原子的な管理者付与](../packages/shared/src/db/users.ts)、
[起動時の必須設定検証](../workers/id/src/utils/env-validation.ts) です。

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
