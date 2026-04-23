# デプロイ手順・シークレット管理ガイド

本ドキュメントでは、各 Worker のデプロイフローとシークレット管理について説明する。
初回セットアップ（D1 作成・ES256 鍵生成・Google OAuth 設定等）は [cloudflare-github-setup.md](./cloudflare-github-setup.md) を参照。

---

## 1. デプロイコマンド一覧

すべてリポジトリルートから実行する。

```bash
npm run deploy:id      # id Worker（IdP コア）
npm run deploy:user    # user Worker（ユーザー BFF）
npm run deploy:admin   # admin Worker（管理画面 BFF）
npm run deploy:mcp     # mcp Worker（Claude Code 連携）
```

### 各コマンドの内部フロー

| Worker | フロー                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------- |
| id     | preflight → D1 マイグレーション適用 → TypeScript ビルド → 静的アセット生成 → `wrangler deploy` |
| user   | preflight → TypeScript ビルド → Astro フロントエンドビルド → `wrangler deploy`                 |
| admin  | preflight → TypeScript ビルド → Astro フロントエンドビルド → `wrangler deploy`                 |
| mcp    | TypeScript ビルド → `wrangler deploy`（preflight なし）                                        |

---

## 2. シークレット一覧

### id Worker（id.0g0.xyz）

| シークレット名                  | 用途                                    | preflight 検査 |
| ------------------------------- | --------------------------------------- | :------------: |
| `GOOGLE_CLIENT_ID`              | Google OAuth クライアント ID            |       —        |
| `GOOGLE_CLIENT_SECRET`          | Google OAuth クライアントシークレット   |       —        |
| `JWT_PRIVATE_KEY`               | ES256 署名用秘密鍵（PEM）               |       —        |
| `JWT_PUBLIC_KEY`                | ES256 検証用公開鍵（PEM）               |       —        |
| `COOKIE_SECRET`                 | Cookie 署名鍵                           |       —        |
| `BOOTSTRAP_ADMIN_EMAIL`         | 初回管理者メールアドレス                |       —        |
| `INTERNAL_SERVICE_SECRET_USER`  | user BFF からの Service Binding 認証用  |       ✅       |
| `INTERNAL_SERVICE_SECRET_ADMIN` | admin BFF からの Service Binding 認証用 |       ✅       |

### user Worker（user.0g0.xyz）

| シークレット名                 | 用途                                               | preflight 検査 |
| ------------------------------ | -------------------------------------------------- | :------------: |
| `SESSION_SECRET`               | セッション Cookie 署名鍵                           |       —        |
| `INTERNAL_SERVICE_SECRET_SELF` | id Worker への Service Binding 認証トークン        |       —        |
| `DBSC_ENFORCE_SENSITIVE`       | DBSC（Device Bound Session Credentials）強制モード |       ✅       |

### admin Worker（admin.0g0.xyz）

| シークレット名                 | 用途                                        | preflight 検査 |
| ------------------------------ | ------------------------------------------- | :------------: |
| `SESSION_SECRET`               | セッション Cookie 署名鍵                    |       —        |
| `INTERNAL_SERVICE_SECRET_SELF` | id Worker への Service Binding 認証トークン |       —        |
| `DBSC_ENFORCE_SENSITIVE`       | DBSC 強制モード                             |       ✅       |

### mcp Worker（mcp.0g0.xyz）

専用シークレットなし。id Worker への認証は Service Binding 経由。

---

## 3. シークレットの生成と設定

### 3.1 BFF 認証シークレット（INTERNAL_SERVICE_SECRET）

user/admin BFF が id Worker を Service Binding で呼び出す際の認証に使う。
**id 側と BFF 側で同じ値を設定する必要がある。**

```bash
# 1. ランダムな秘密鍵を生成
SECRET_USER=$(openssl rand -base64 32)
SECRET_ADMIN=$(openssl rand -base64 32)

# 2. id Worker に登録
cd workers/id
echo "$SECRET_USER"  | npx wrangler secret put INTERNAL_SERVICE_SECRET_USER
echo "$SECRET_ADMIN" | npx wrangler secret put INTERNAL_SERVICE_SECRET_ADMIN

# 3. 対応する BFF に登録（値は id 側と同一にすること）
cd ../user
echo "$SECRET_USER" | npx wrangler secret put INTERNAL_SERVICE_SECRET_SELF

cd ../admin
echo "$SECRET_ADMIN" | npx wrangler secret put INTERNAL_SERVICE_SECRET_SELF
```

> ⚠️ id 側の `INTERNAL_SERVICE_SECRET_USER` と user 側の `INTERNAL_SERVICE_SECRET_SELF` は**同じ値**でなければならない。admin も同様。片方だけ変更すると BFF → id 間の認証が 403 で全壊する。

### 3.2 DBSC 強制モード（DBSC_ENFORCE_SENSITIVE）

Device Bound Session Credentials の動作モードを制御する。

| 値                 | 動作                                         |
| ------------------ | -------------------------------------------- |
| 未設定 / `"false"` | warn-only（ログ出力のみ、リクエストは通す）  |
| `"true"`           | enforce（DBSC 検証失敗時にリクエストを拒否） |

```bash
# 強制モードを有効化
cd workers/user
echo "true" | npx wrangler secret put DBSC_ENFORCE_SENSITIVE

cd ../admin
echo "true" | npx wrangler secret put DBSC_ENFORCE_SENSITIVE
```

### 3.3 セッションシークレット

```bash
SESSION=$(openssl rand -base64 32)

cd workers/user
echo "$SESSION" | npx wrangler secret put SESSION_SECRET

cd ../admin
echo "$SESSION" | npx wrangler secret put SESSION_SECRET
```

> user と admin で別々の値を使っても問題ない（ドメインが異なるため Cookie は共有されない）。

---

## 4. Preflight Deploy（デプロイ前検査）

デプロイ時に重要なシークレットの登録漏れを検出する仕組み。
`packages/shared/src/lib/preflight-core.ts` を共通基盤として、各 Worker が個別のチェックを実装している。

### 検査対象

| Worker | チェック内容                                                                 |
| ------ | ---------------------------------------------------------------------------- |
| id     | `INTERNAL_SERVICE_SECRET_USER` と `INTERNAL_SERVICE_SECRET_ADMIN` の登録有無 |
| user   | `DBSC_ENFORCE_SENSITIVE` の登録有無                                          |
| admin  | `DBSC_ENFORCE_SENSITIVE` の登録有無                                          |
| mcp    | preflight なし                                                               |

### 動作モード

| 環境変数           | 値  | 動作                                                  |
| ------------------ | --- | ----------------------------------------------------- |
| （デフォルト）     | —   | 未登録を warn 表示するが、デプロイは続行（fail-open） |
| `PREFLIGHT_STRICT` | `1` | 未登録があればデプロイを中断（exit code 1）           |
| `SKIP_PREFLIGHT`   | `1` | preflight を完全にスキップ                            |

```bash
# strict モードでデプロイ（CI 推奨）
PREFLIGHT_STRICT=1 npm run deploy:id

# preflight をスキップ（デバッグ時のみ）
SKIP_PREFLIGHT=1 npm run deploy:user
```

### CI/CD での推奨設定

CI パイプラインでは `PREFLIGHT_STRICT=1` を**必ず**設定すること。
シークレット登録漏れのまま本番反映される事故を防止する。

```yaml
# GitHub Actions の例
env:
  PREFLIGHT_STRICT: "1"
```

---

## 5. D1 マイグレーション

マイグレーションファイルは `migrations/` ディレクトリに配置される。
`deploy:id` の内部で自動適用されるが、**push 前に手動で本番 DB へ適用することを推奨する**。

### 5.1 マイグレーション適用コマンド

```bash
# 本番 DB にマイグレーション適用
npm run migrate:id

# ローカル D1 にマイグレーション適用（開発時）
cd workers/id
npx wrangler d1 migrations apply 0g0-id-db --local
```

> ⚠️ 新しいマイグレーションファイルを追加して適用せずにデプロイすると、`D1_ERROR: no such column` が本番で発生する。

### 5.2 マイグレーションファイル一覧

| ファイル                                  | 概要                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `0001_initial.sql`                        | 初期スキーマ（users, services, service_redirect_uris, auth_codes, refresh_tokens） |
| `0002_performance_indexes.sql`            | auth_codes / refresh_tokens に部分インデックス追加                                 |
| `0003_user_profile_fields.sql`            | ユーザープロフィール拡張（phone, address）                                         |
| `0004_auth_codes_cascade_delete.sql`      | auth_codes.user_id に ON DELETE CASCADE 追加                                       |
| `0005_add_line_twitch_providers.sql`      | LINE・Twitch プロバイダー対応                                                      |
| `0006_add_github_x_providers.sql`         | GitHub・X プロバイダー対応                                                         |
| `0007_login_events.sql`                   | ログインイベント記録テーブル                                                       |
| `0008_auth_codes_service_id.sql`          | auth_codes に service_id カラム追加                                                |
| `0009_oidc_improvements.sql`              | OIDC 改善（nonce, code_challenge, scope 等）                                       |
| `0010_user_ban.sql`                       | ユーザー停止機能（banned_at）                                                      |
| `0011_admin_audit_logs.sql`               | 管理者監査ログテーブル                                                             |
| `0012_login_events_country.sql`           | login_events に country カラム追加                                                 |
| `0013_refresh_token_revoke_reason.sql`    | refresh_tokens に revoked_reason カラム追加                                        |
| `0014_admin_audit_logs_add_status.sql`    | admin_audit_logs に status カラム追加                                              |
| `0015_refresh_tokens_pairwise_sub.sql`    | refresh_tokens にペアワイズ sub カラム追加                                         |
| `0016_refresh_tokens_scope.sql`           | リフレッシュトークンに発行時スコープを記録                                         |
| `0017_device_codes.sql`                   | Device Authorization Grant（RFC 8628）用テーブル                                   |
| `0018_device_codes_check_constraint.sql`  | device_codes に CHECK 制約追加                                                     |
| `0019_mcp_sessions.sql`                   | MCP セッション管理テーブル                                                         |
| `0020_revoked_access_tokens.sql`          | アクセストークン失効テーブル（jti ブロックリスト）                                 |
| `0021_add_user_id_to_mcp_sessions.sql`    | mcp_sessions に user_id カラム追加                                                 |
| `0022_auth_codes_provider.sql`            | auth_codes に provider カラム追加（amr クレーム用）                                |
| `0023_bff_sessions.sql`                   | BFF セッション管理テーブル                                                         |
| `0024_bff_sessions_dbsc.sql`              | DBSC Phase 1（device_public_key_jwk, device_bound_at）                             |
| `0025_dbsc_challenges.sql`                | DBSC Phase 2 チャレンジテーブル                                                    |
| `0026_additional_performance_indexes.sql` | パフォーマンス改善：複合インデックス追加                                           |
| `0027_account_lockouts.sql`               | アカウントロックアウト管理                                                         |

### 5.3 ローカル開発でのマイグレーション

ローカル D1 は `--local` フラグで操作する。`wrangler d1 migrations apply` はまだ適用されていないマイグレーションのみを実行する。

```bash
cd workers/id

# 全マイグレーションを一括適用（未適用分のみ実行）
npx wrangler d1 migrations apply 0g0-id-db --local

# 個別に SQL を実行する場合（デバッグ用）
npx wrangler d1 execute 0g0-id-db --local --file=../../migrations/0027_account_lockouts.sql

# ローカル DB の中身を確認
npx wrangler d1 execute 0g0-id-db --local --command="SELECT name FROM sqlite_master WHERE type='table'"
```

### 5.4 マイグレーション失敗時のロールバック

D1 にはネイティブのロールバック機能がないため、**Time Travel** を使用して復旧する。

#### Time Travel による復旧手順

```bash
# 1. マイグレーション適用前のブックマークを取得
#    （事前に記録しておくか、タイムスタンプから逆算）
npx wrangler d1 time-travel info 0g0-id-db

# 2. 特定時点のブックマークに復元
npx wrangler d1 time-travel restore 0g0-id-db --bookmark=<bookmark_id>

# 3. 復元後、アプリケーションの動作を確認
curl https://id.0g0.xyz/api/health
```

#### 注意事項

- Time Travel の保持期間はプランに依存（Workers Free: 過去 30 日）
- 復元はデータベース全体に影響する（特定テーブルのみの復元は不可）
- 復元後はマイグレーション管理テーブル（`d1_migrations`）の状態も巻き戻るため、修正済みマイグレーションの再適用が必要

---

## 6. デプロイ順序

Worker 間に Service Binding の依存関係があるため、初回デプロイや大規模変更時は以下の順序を推奨する。

```
1. id Worker（他の全 Worker が依存）
2. user / admin Worker（id に依存、互いに独立）
3. mcp Worker（id に依存）
```

通常の機能開発では、変更した Worker のみデプロイすればよい。

---

## 7. 鍵ローテーション

ES256 鍵ペアをローテーションする場合は、以下の**両方**を更新すること。

```bash
# 1. 新しい鍵ペアを生成
openssl ecparam -genkey -name prime256v1 -noout -out private-new.pem
openssl ec -in private-new.pem -pubout -out public-new.pem

# 2. Worker シークレットを更新
cd workers/id
cat private-new.pem | npx wrangler secret put JWT_PRIVATE_KEY
cat public-new.pem  | npx wrangler secret put JWT_PUBLIC_KEY

# 3. 公開鍵 JWK ファイルを更新してコミット
#    public-key.jwk.json は JWKS エンドポイント用の静的アセットに使われる
#    JWT_PUBLIC_KEY env var を設定してビルドすると自動変換される
export JWT_PUBLIC_KEY="$(cat public-new.pem)"
npm run deploy:id

# 4. public-key.jwk.json を新しい JWK に差し替えてコミット
```

> ⚠️ Worker シークレットだけ更新して `public-key.jwk.json` を更新しないと、JWKS エンドポイント（`/.well-known/jwks.json`）が古い公開鍵を返し続け、外部サービスの JWT 検証が失敗する。

---

## 8. トラブルシューティング

### BFF から id Worker への認証が 403 になる

`INTERNAL_SERVICE_SECRET_SELF`（BFF 側）と `INTERNAL_SERVICE_SECRET_USER` / `INTERNAL_SERVICE_SECRET_ADMIN`（id 側）の値が一致しているか確認する。

```bash
# 登録済みシークレット一覧を確認（値は表示されない）
cd workers/id && npx wrangler secret list
cd workers/user && npx wrangler secret list
```

### Preflight が wrangler エラーで失敗する

Preflight は `wrangler secret list` を内部で実行する。Cloudflare の認証が切れている場合はエラーになるが、fail-open のためデプロイ自体は続行される。

```bash
# 認証状態を確認
npx wrangler whoami
```

### DBSC 関連のリクエスト拒否

`DBSC_ENFORCE_SENSITIVE=true` の状態で DBSC 検証に失敗するとリクエストが拒否される。
一時的に無効化するには:

```bash
echo "false" | npx wrangler secret put DBSC_ENFORCE_SENSITIVE
```
