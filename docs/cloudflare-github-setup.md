# Cloudflare Workers GitHub直接接続設定ガイド

## 前提条件
- Cloudflareアカウント
- GitHubリポジトリ（0g0-id）
- Wrangler CLIインストール済み

## D1データベース作成
```bash
wrangler d1 create 0g0-id-db
# 出力されたdatabase_idをworkers/id/wrangler.tomlに設定
```

## マイグレーション実行
```bash
# 本番
wrangler d1 execute 0g0-id-db --file=migrations/0001_initial.sql
# ローカル
wrangler d1 execute 0g0-id-db --local --file=migrations/0001_initial.sql
```

## Worker設定

### Worker 1: 0g0-id (id.0g0.xyz)
| 設定項目 | 値 |
|---|---|
| Framework preset | None |
| Build command | `npm ci && npm run deploy:id` |
| Build output directory | (空) |
| Root directory | `/` |
| NODE_VERSION | `20` |

### Worker 2: 0g0-id-user (user.0g0.xyz)
| 設定項目 | 値 |
|---|---|
| Framework preset | None |
| Build command | `npm ci && npm run deploy:user` |
| Build output directory | (空) |
| Root directory | `/` |
| NODE_VERSION | `20` |

### Worker 3: 0g0-id-admin (admin.0g0.xyz)
| 設定項目 | 値 |
|---|---|
| Framework preset | None |
| Build command | `npm ci && npm run deploy:admin` |
| Build output directory | (空) |
| Root directory | `/` |
| NODE_VERSION | `20` |

## シークレット設定（Cloudflare Dashboard — id worker）
```bash
wrangler secret put GOOGLE_CLIENT_ID --name 0g0-id
wrangler secret put GOOGLE_CLIENT_SECRET --name 0g0-id
wrangler secret put JWT_PRIVATE_KEY --name 0g0-id
wrangler secret put JWT_PUBLIC_KEY --name 0g0-id
wrangler secret put BOOTSTRAP_ADMIN_EMAIL --name 0g0-id
```

## ES256鍵ペア生成
```bash
# 秘密鍵
openssl ecparam -genkey -name prime256v1 -noout -out private.pem
# 公開鍵
openssl ec -in private.pem -pubout -out public.pem
# 内容確認
cat private.pem
cat public.pem
```

## Service Bindings
wrangler.toml設定後、Cloudflare Dashboardで Service Bindings を有効化:
- user worker → id worker
- admin worker → id worker

## ローカル開発（workers/id/.dev.vars）
```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
JWT_PRIVATE_KEY=-----BEGIN EC PRIVATE KEY-----
...
-----END EC PRIVATE KEY-----
JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
```

## 補足
- 同一リポジトリから3つのWorkerをデプロイ
- Cloudflare Dashboardで3つのWorkerを作成し、それぞれ同じGitHubリポジトリを接続
- push時に全Workerが再デプロイ
