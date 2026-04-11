# Cloudflare Workers × GitHub 接続設定ガイド

同一の GitHub リポジトリから 3 つの Worker をデプロイする手順をまとめます。

---

## 0. 前提条件

- Cloudflare アカウント（Workers Paid プラン推奨）
- GitHub リポジトリ: `g-kari/0g0-id`
- Node.js 20+
- Wrangler CLI（`npx wrangler` で使用可）

---

## 1. D1 データベース作成（初回のみ）

```bash
npx wrangler d1 create 0g0-id-db
```

出力された `database_id` を `workers/id/wrangler.toml` の以下の箇所に設定:

```toml
[[d1_databases]]
binding = "DB"
database_name = "0g0-id-db"
database_id = "<ここに貼り付け>"
```

### マイグレーション実行

```bash
cd workers/id
npx wrangler d1 execute 0g0-id-db --remote --file=../../migrations/0001_initial.sql
```

---

## 2. ES256 鍵ペア生成（初回のみ）

```bash
openssl ecparam -genkey -name prime256v1 -noout -out private.pem
openssl ec -in private.pem -pubout -out public.pem
```

> ⚠️ `private.pem` は 1Password 等に保管してください。ファイルはそのまま残さないこと。

---

## 3. シークレット設定（初回のみ）

`workers/id` ディレクトリで実行:

```bash
cd workers/id

echo "<Google OAuth Client ID>" | npx wrangler secret put GOOGLE_CLIENT_ID
echo "<Google OAuth Client Secret>" | npx wrangler secret put GOOGLE_CLIENT_SECRET
cat private.pem | npx wrangler secret put JWT_PRIVATE_KEY
cat public.pem  | npx wrangler secret put JWT_PUBLIC_KEY
echo "admin@0g0.xyz" | npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

| シークレット名 | 説明 | 取得元 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 クライアント ID | [Google Cloud Console](https://console.cloud.google.com/) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 クライアントシークレット | 同上 |
| `JWT_PRIVATE_KEY` | ES256 署名用秘密鍵（PEM） | `private.pem` |
| `JWT_PUBLIC_KEY` | ES256 検証用公開鍵（PEM） | `public.pem` |
| `BOOTSTRAP_ADMIN_EMAIL` | 初回管理者として登録するメールアドレス | 任意 |

### Google Cloud Console での設定

1. [Google Cloud Console](https://console.cloud.google.com/) → 「認証情報」→「OAuth 2.0 クライアント ID」を作成
2. アプリケーションの種類: **ウェブアプリケーション**
3. 承認済みのリダイレクト URI に追加:
   ```
   https://id.0g0.xyz/auth/callback
   ```

---

## 3.5. GitHub OAuth プロバイダーの設定（オプション）

GitHub ログイン/アカウント連携を有効化する場合のみ実施してください。Google 認証のみ使う場合はスキップ可能です。

### GitHub OAuth App の作成

> **注意:** **GitHub Apps** ではなく **OAuth Apps** を使用してください。

1. GitHub にログインし [https://github.com/settings/developers](https://github.com/settings/developers) を開く
2. 「OAuth Apps」→「New OAuth App」をクリック
3. 以下の値を入力:

| フィールド | 設定値 |
|---|---|
| Application name | `0g0-id`（任意） |
| Homepage URL | `https://id.0g0.xyz` |
| Authorization callback URL | `https://id.0g0.xyz/auth/callback` |

4. 「Register application」をクリック
5. 作成後の画面で「Generate a new client secret」をクリックし **Client Secret** を生成
6. **Client ID** と **Client Secret** をメモしておく（Client Secret はこの画面でしか確認できません）

> ローカル開発用に別の OAuth App を作成し、callback URL を `http://localhost:8787/auth/callback` に設定することを推奨します。

### Cloudflare Workers へのシークレット設定

`workers/id` ディレクトリで実行:

```bash
cd workers/id

echo "<GitHub OAuth App の Client ID>" | npx wrangler secret put GITHUB_CLIENT_ID
echo "<GitHub OAuth App の Client Secret>" | npx wrangler secret put GITHUB_CLIENT_SECRET
```

| シークレット名 | 説明 |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth App の Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App の Client Secret |

> **重要:** `GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET` は**両方セット**してください。片方だけ設定すると起動時のバリデーションエラー（`GitHub の CLIENT_ID と CLIENT_SECRET は両方設定してください`）でリクエストが全て 503 になります。

### ローカル開発時の `.dev.vars` への追記

`workers/id/.dev.vars` に以下を追加:

```
GITHUB_CLIENT_ID=<ローカル開発用 Client ID>
GITHUB_CLIENT_SECRET=<ローカル開発用 Client Secret>
```

---

## 4. GitHub リポジトリ接続（Cloudflare Dashboard）

同じリポジトリを 3 つの Worker それぞれに接続します。
**Cloudflare Dashboard → Workers & Pages → 各 Worker → Settings → Build**

### Worker 1: `0g0-id`（id.0g0.xyz）

| 項目 | 設定値 |
|---|---|
| Git リポジトリ | `g-kari/0g0-id` |
| Production branch | `master` |
| Framework preset | **None** |
| Build command | `npm ci && npm run deploy:id` |
| Build output directory | （空欄） |
| Root directory | `/`（リポジトリルート） |

**環境変数（Build のみ）:**

| 変数名 | 値 |
|---|---|
| `NODE_VERSION` | `20` |

### Worker 2: `0g0-id-user`（user.0g0.xyz）

| 項目 | 設定値 |
|---|---|
| Git リポジトリ | `g-kari/0g0-id` |
| Production branch | `master` |
| Framework preset | **None** |
| Build command | `npm ci && npm run deploy:user` |
| Build output directory | （空欄） |
| Root directory | `/` |

**環境変数（Build のみ）:**

| 変数名 | 値 |
|---|---|
| `NODE_VERSION` | `20` |

### Worker 3: `0g0-id-admin`（admin.0g0.xyz）

| 項目 | 設定値 |
|---|---|
| Git リポジトリ | `g-kari/0g0-id` |
| Production branch | `master` |
| Framework preset | **None** |
| Build command | `npm ci && npm run deploy:admin` |
| Build output directory | （空欄） |
| Root directory | `/` |

**環境変数（Build のみ）:**

| 変数名 | 値 |
|---|---|
| `NODE_VERSION` | `20` |

> **注意:** シークレット（`GOOGLE_CLIENT_ID` など）は Build 環境変数ではなく、Worker の **Variables & Secrets** に設定してください。Build 時には不要です。

---

## 5. Service Bindings 確認

`workers/user/wrangler.toml` と `workers/admin/wrangler.toml` に以下が設定されています:

```toml
[[services]]
binding = "IDP"
service = "0g0-id"
```

デプロイ後、Cloudflare Dashboard で各 Worker の **Settings → Bindings** に `IDP → 0g0-id` が表示されていることを確認してください。

---

## 6. カスタムドメイン設定

`id.0g0.xyz` / `user.0g0.xyz` / `admin.0g0.xyz` の DNS が Cloudflare で管理されている場合、`wrangler.toml` の `custom_domain = true` 設定により自動的にルーティングされます。

DNS が未設定の場合は Cloudflare Dashboard → **Workers & Pages → 各 Worker → Settings → Domains & Routes** から手動で追加してください。

---

## 7. ローカル開発

`workers/id/.dev.vars` を作成（`.gitignore` 済み）:

```
GOOGLE_CLIENT_ID=575085222041-xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
JWT_PRIVATE_KEY=-----BEGIN EC PRIVATE KEY-----
MHcCAQEE...
-----END EC PRIVATE KEY-----
JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----
MFkwEwYH...
-----END PUBLIC KEY-----
BOOTSTRAP_ADMIN_EMAIL=admin@0g0.xyz
IDP_ORIGIN=http://localhost:8787
USER_ORIGIN=http://localhost:8788
ADMIN_ORIGIN=http://localhost:8789
```

```bash
npm run dev:id     # :8787
npm run dev:user   # :8788
npm run dev:admin  # :8789
```

---

## 8. デプロイ確認

```bash
curl https://id.0g0.xyz/api/health
curl https://user.0g0.xyz/api/health
curl https://admin.0g0.xyz/api/health
```

すべて `{"status":"ok"}` が返れば正常です。

---

## トラブルシューティング

### `JWT_PRIVATE_KEY` の改行が失われる

PEM 鍵を環境変数として渡す際に改行が消える場合があります。`cat` パイプで設定すると正しく保存されます:

```bash
cat private.pem | npx wrangler secret put JWT_PRIVATE_KEY
```

### Service Bindings が `undefined` になる

ローカル開発時は Service Bindings が機能しません。`wrangler dev` の `--service` オプションか、別途 id worker をローカルで起動してください。

### D1 マイグレーション再実行

スキーマ変更時は新しいマイグレーションファイルを追加し、`--remote` フラグ付きで実行してください。`0001_initial.sql` を直接編集すると既存データが失われます。
