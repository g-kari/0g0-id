# アーキテクチャ

## システム概要

0g0-id は Cloudflare Workers 上に構築された統合ID基盤（IdP）モノレポ。OAuth 2.0 / OIDC 準拠の認証・認可を提供する。

```
┌──────────────────────────────────────────────────────────────────┐
│  ブラウザ                                                         │
│  ├── user.0g0.xyz (ユーザーダッシュ��ード)                         │
│  └── admin.0g0.xyz (管理画面)                                     │
└───────────┬────────────────────────────────┬───────────────��─────┘
            │ HTTPS + Cookie                  │ HTTPS + Cookie
            ▼                                 ▼
┌───────────────────┐              ┌───────────────────┐
│  user Worker      │              │  admin Worker     │
│  (BFF + Astro)    │              │  (BFF + Astro)    │
└─────────┬─────────┘              └───��─────┬─────────┘
          │ Service Binding                   │ Service Binding
          │ + X-Internal-Secret               │ + X-Internal-Secret
          ▼                                   ��
┌────────────��────────────────────────────────────────────────────┐
│  id Worker (IdP コア)                                            │
│  ├── OAuth 2.0 + PKCE (認可コードフロー)                          │
│  ├─�� JWT 発行/検証 (ES256)                                       │
│  ├── リフレッシュトークンローテーション                              │
│  ├── DBSC (Device Bound Session Credentials)                     │
│  └── 外部サービス向け API (token introspect, userinfo)             │
└─────────────────────────────────────────────────┬───────────────┘
                                                  │
                     ┌────────────────────────────┼────────────┐
                     │                            │            │
                     ▼                            ▼            ▼
              ┌────────────┐             ┌──────────┐   ┌───────────┐
              │ D1 (SQLite)│             │ OAuth    │   │ mcp Worker│
              │ 0g0-id-db  │             │ Providers│   │ (MCP)     │
              └────────────┘             └──────────┘   └───────────┘
                                          Google/LINE/
                                          Twitch/GitHub/X
```

## Worker 構成

| Worker | ドメイン      | 役割                         | 主要バインディング            |
| ------ | ------------- | ---------------------------- | ----------------------------- |
| id     | id.0g0.xyz    | IdP コア API                 | DB, Rate Limiters, Assets     |
| user   | user.0g0.xyz  | ユーザー向け BFF + Astro MPA | IDP (Service Binding), Assets |
| admin  | admin.0g0.xyz | 管理画面 BFF + Astro MPA     | IDP (Service Binding), Assets |
| mcp    | mcp.0g0.xyz   | Claude Code 連携             | IDP (Service Binding), DB     |

## 認証フロー

### OAuth 2.0 認可コードフロー (BFF 経由)

```
Browser          user/admin BFF         id Worker            OAuth Provider
   │                  │                     │                      │
   │ GET /auth/login  │                     │                      │
   │─────────────────>│                     │                      │
   │                  │ GET /auth/login     │                      │
   │                  │ (Service Binding)   │                      │
   │                  │────────────────────>│                      │
   │                  │                     │ state + PKCE 生��     │
   │                  │ 302 → Provider      │                      │
   │<─────────────────│<────────────────────│                      │
   │                  │                     │                      │
   │ GET /auth/callback?code=...            │                      │
   │─────────────────>│                     │                      │
   │                  │ GET /auth/callback  │                      │
   │                  │────────────────────>│                      │
   │                  │                     │ code → token exchange │
   │                  │                     │─────────────────────>│
   │                  ���                     │<─────────────────────│
   │                  │                     │                      │
   │                  │                     │ ユーザー upsert       │
   │                  │                     │ 認可コード発行        │
   │                  │ auth_code           │                      │
   │                  │<────────────���───────│                      │
   │                  │                     │                      │
   │                  │ POST /auth/exchange │                      │
   │                  │ (X-Internal-Secret) │                      │
   │                  │────────────────���───>│                      │
   │                  ��                     │ JWT (access + refresh)│
   │                  ��� tokens              │                      │
   │                  │<──────────��─────────│                      │
   │                  │                     │                      │
   │ Set-Cookie:      │                     │                      │
   │ __Host-*-session │                     │                      │
   │<─────────────────│                     │                      │
```

### トークンライフサイクル

| トークン種別          | 有効期間 | 保存場所                       | ローテーショ���                   |
| --------------------- | -------- | ------------------------------ | --------------------------------- |
| アクセストークン      | 15分     | BFF セッション Cookie (暗号化) | なし                              |
| リフレッ���ュトークン | 30日     | BFF セッション Cookie (暗号��) | 使用毎に新規発行 + 旧トークン失効 |
| BFF セッション Cookie | 30日     | ブラウザ (\_\_Host- prefix)    | AES-GCM 暗号化                    |

リフレッシュトークンは **family ID** で追跡され、旧トークンの再使用を検出した場合はファミリー全体を失効する（リプレイ攻撃検知）。

### DBSC (Device Bound Session Credentials)

ブラウザ端末に紐づく ES256 鍵ペアでセッションをバインドし、Cookie 単体の窃取によるハイジャックを防止する。

```
Browser                    BFF                      id Worker
   │                        │                          │
   │ (ログイン成功後)        │                          │
   │ Sec-Session-Registration│                          │
   │<───────────────────────│                          │
   │                        │                          │
   │ POST /auth/dbsc/start  ��                          │
   │ (自署JWT: ES256,       │ POST /auth/dbsc/bind    │
   │  aud=SELF_ORIGIN)      │─────────────────────────>│
   │──────────────────��────>│                          │ 公開鍵を session に紐付け
   │                        │<─────────────────────────│
   │ 200 (bound)            │                          │
   │<───────────────────────│                          │
   │                        │                          │
   │ (定期 refresh)          │                          │
   │ POST /auth/dbsc/refresh │ POST /auth/dbsc/challenge│
   │───────────────────────>│───��─────────────────────>│
   │ 403 + Challenge nonce  │<─────────────────────────│
   │<───────────────────────│                          │
   │                        │                          │
   │ POST /auth/dbsc/refresh │ POST /auth/dbsc/verify  │
   │ Sec-Session-Response:   │────────��────────────────>│
   │ (proof JWT signed      │                          │ nonce 消費 + 署名検証
   │  with device key)      │<─────────────────────────│
   │─────────────────���─────>│                          │
   │ 200 (refreshed)        │                          │
   │<──────��────────────────│                          │
```

## データベース設計

D1 (SQLite) を id / mcp Worker で共有。主要テーブル:

| テーブル              | 役割                                                 |
| --------------------- | ---------------------------------------------------- |
| users                 | ユーザー (OAuth プロバイダー sub, role, ban 状態)    |
| services              | OAuth クライアント (client_id, client_secret_hash)   |
| service_redirect_uris | 許可リダイレクト URI                                 |
| auth_codes            | 認可コード (PKCE, nonce, scope 付き)                 |
| refresh_tokens        | リフレッシュトークン (family ID, ローテーション追跡) |
| bff_sessions          | BFF セッション (リモート失効, DBSC バインド)         |
| dbsc_challenges       | DBSC challenge nonce (ワンタイム, TTL 60秒)          |
| login_events          | ログ���ン監査ログ                                    |
| admin_audit_logs      | 管理者操作監査ログ                                   |
| device_codes          | Device Authorization Grant (RFC 8628)                |
| mcp_sessions          | MCP セッション管理                                   |
| revoked_access_tokens | アクセストークン jti ブロックリスト                  |

マイグレーションは `migrations/` ディレクトリに連番管理（0001〜0026）。

## レート制限

Cloudflare Workers Rate Limiting binding を使用:

| バインディング             | 上限    | 期間 | 対象                          |
| -------------------------- | ------- | ---- | ----------------------------- |
| RATE_LIMITER_AUTH          | 20 req  | 60s  | /auth/login, /auth/callback   |
| RATE_LIMITER_TOKEN         | 30 req  | 60s  | /auth/exchange, /auth/refresh |
| RATE_LIMITER_TOKEN_CLIENT  | 100 req | 60s  | /api/token (client_id 単位)   |
| RATE_LIMITER_EXTERNAL      | 200 req | 60s  | /api/external/\*              |
| RATE_LIMITER_DEVICE_VERIFY | 10 req  | 60s  | /api/device/verify            |

## セキュリティ設計

- **JWT 署名**: ES256 のみ (jose + WebCrypto)。kid ヘッダー付き
- **Cookie**: `__Host-` prefix + HttpOnly + Secure + SameSite=Lax
- **OAuth**: state + PKCE (S256) 必須
- **CSRF**: Origin ヘッダー検証 (SELF_ORIGIN との一致)
- **BFF 認証**: 個別シークレット (INTERNAL_SERVICE_SECRET_USER / \_ADMIN)
- **トークン失効**: BAN / ロール変更時は D1 batch() でトランザクション一括失効
- **外部クライアント**: Basic 認証 (client_id:client_secret)

## 静的アセット配信

Workers Assets を使用。Astro で静的 HTML を生成し、`not_found_handling = "single-page-application"` でフォールバック。

```
リクエスト
  │
  ├── /auth/*, /api/* → Worker (Hono ルーティング)
  │
  └── /_astro/*, /*.html → Workers Assets (静的ファイル直接配信)
       └── SPA fallback → /index.html (該当ルートなし時)
```

id Worker は SPA fallback なし。`.well-known/*.json` と `docs/*.json` のみ静的配信。

## デプロイ

```bash
npm run deploy:id      # preflight (BFF secret チェック) → assets build → wrangler deploy
npm run deploy:user    # preflight (DBSC secret チェック) → frontend build → wrangler deploy
npm run deploy:admin   # preflight (DBSC secret チェック) → frontend build → wrangler deploy
npm run deploy:mcp     # wrangler deploy
```

Preflight スクリプトは `wrangler secret list` で必須シークレットの登録有無を確認する。`PREFLIGHT_STRICT=1` (CI 向け) で未登録時に deploy を中断。

## Cron (定期処理)

id Worker: 毎日 0:00 UTC に以下を実行:

- 期限切れリフレッシュトークンの削除
- 失効済み BFF セッションの削除 (7日保持後)
- 期限切れ DBSC チャレンジの削除
- 期限切れデバイスコードの削除
- 期限切れアクセストークン jti の削除
