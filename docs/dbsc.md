# DBSC（Device Bound Session Credentials）仕様

Chrome の Device Bound Session Credentials を利用したセッションのデバイス紐付け機構。
BFF セッションに端末の公開鍵を結びつけ、チャレンジ・レスポンスで端末所有を証明する。

---

## フェーズ概要

| フェーズ | 機能                                 | 状態                                    |
| -------- | ------------------------------------ | --------------------------------------- |
| Phase 1  | デバイス公開鍵のバインド             | ✅ 実装済み                             |
| Phase 2  | チャレンジ・レスポンス（nonce 検証） | ✅ 実装済み                             |
| Phase 3  | 機密操作の DBSC 必須化               | ✅ 実装済み（warn-only / enforce 切替） |

---

## アーキテクチャ

### Phase 1: デバイス公開鍵バインド

```
Chrome                     BFF (user/admin)              IdP (id)
  │                            │                            │
  │ POST /auth/dbsc/start      │                            │
  │ (自己署名 ES256 JWT)       │                            │
  ├───────────────────────────►│                            │
  │                            │ POST /auth/dbsc/bind       │
  │                            │ (session_id, public_jwk)   │
  │                            ├───────────────────────────►│
  │                            │◄── 200 { bound_at }        │
  │◄── 200 { session_identifier, refresh_url, credentials } │
```

- Chrome が ES256 鍵ペアを生成し、公開鍵を JWT ヘッダの `jwk` フィールドに含めて送信
- BFF が `aud` を `SELF_ORIGIN` と照合後、IdP にバインド要求
- IdP が `bff_sessions.device_public_key_jwk` に公開鍵を記録（二重バインド防止）

### Phase 2: チャレンジ・レスポンス

```
Chrome                     BFF (user/admin)              IdP (id)
  │                            │                            │
  │ POST /auth/dbsc/refresh    │                            │
  │ (Sec-Session-Response なし)│                            │
  ├───────────────────────────►│                            │
  │                            │ POST /auth/dbsc/challenge  │
  │                            ├───────────────────────────►│
  │                            │◄── { nonce, expires_at }   │
  │◄── 403 + Secure-Session-Challenge: "<nonce>"            │
  │                            │                            │
  │ POST /auth/dbsc/refresh    │                            │
  │ Sec-Session-Response: JWT  │                            │
  ├───────────────────────────►│                            │
  │                            │ POST /auth/dbsc/verify     │
  │                            │ (session_id, jwt)          │
  │                            ├───────────────────────────►│
  │                            │◄── 200 { verified_at }     │
  │◄── 200 { session_identifier }                           │
```

- nonce は 60 秒 TTL、base64url 32 バイト（256 ビットエントロピー）
- Proof JWT: `aud = SELF_ORIGIN`, `jti = nonce`（必須クレーム）
- nonce はアトミックに一回限り消費（リプレイ防止）

### Phase 3: 機密操作の DBSC 必須化

デバイスバインドされていないセッションからの破壊的操作（POST/PATCH/PUT/DELETE）を制限する。

**user BFF の保護対象:**

- `/api/me/*` — プロフィール更新・削除
- `/api/connections/*` — サービス連携解除
- `/api/device/*` — デバイス認可
- `/api/providers/*` — SNS 連携解除
- `/auth/link` — SNS 連携追加

**admin BFF の保護対象:**

- `/api/services/*` — サービス管理（作成・更新・削除）
- `/api/users/*` — ユーザー管理（BAN・ロール変更・セッション失効）

---

## IdP 内部 API

すべて `serviceBindingMiddleware`（`X-Internal-Secret` 必須）で保護される。

| エンドポイント         | メソッド | 説明                                       |
| ---------------------- | -------- | ------------------------------------------ |
| `/auth/dbsc/bind`      | POST     | デバイス公開鍵をセッションに紐付け         |
| `/auth/dbsc/challenge` | POST     | リフレッシュ用 nonce 発行                  |
| `/auth/dbsc/verify`    | POST     | Proof JWT 検証 + nonce 消費                |
| `/auth/dbsc/status`    | POST     | セッションのバインド状態確認（Phase 3 用） |

### セキュリティ設計

- **X-BFF-Origin 検証**: 呼び出し元 BFF のオリジンとセッション発行元が一致しない場合は 403
- **列挙攻撃対策**: `/auth/dbsc/status` は存在しない・期限切れ・他 BFF 発行のセッションをすべて `device_bound=false` で統一応答
- **Fail-open**: IdP エラー時はバインドなしセッションを許可（運用継続優先、監査ログ記録）

---

## データベーススキーマ

### bff_sessions テーブル拡張（Migration 0024）

```sql
ALTER TABLE bff_sessions ADD COLUMN device_public_key_jwk TEXT;
ALTER TABLE bff_sessions ADD COLUMN device_bound_at INTEGER;
```

### dbsc_challenges テーブル（Migration 0025）

```sql
CREATE TABLE dbsc_challenges (
  nonce TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES bff_sessions (id) ON DELETE CASCADE
);
```

---

## 強制モード設定

### 環境変数

| 変数                     | 対象                           | 説明                                               |
| ------------------------ | ------------------------------ | -------------------------------------------------- |
| `DBSC_ENFORCE_SENSITIVE` | user/admin Worker シークレット | `"true"` で強制モード有効（デフォルト: warn-only） |
| `PREFLIGHT_STRICT`       | CI 環境変数                    | `"1"` でデプロイ時の preflight チェックを必須化    |
| `SKIP_PREFLIGHT`         | 緊急時環境変数                 | `"1"` で preflight チェックをスキップ              |

### 動作マトリクス

| `DBSC_ENFORCE_SENSITIVE` | ランタイム動作                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| 未設定 or `"false"`      | warn-only（監査ログのみ、操作は許可）                                |
| `"true"`                 | 403 `DBSC_BINDING_REQUIRED` + `Secure-Session-Registration` ヘッダー |

> ⚠️ Preflight は `PREFLIGHT_STRICT` を `"1"` と比較し、ランタイムは `DBSC_ENFORCE_SENSITIVE` を `"true"` と比較する。値の混同に注意。

---

## 関連ファイル

| ファイル                                        | 説明                         |
| ----------------------------------------------- | ---------------------------- |
| `workers/id/src/routes/auth/dbsc.ts`            | IdP 側 DBSC エンドポイント   |
| `packages/shared/src/lib/bff-dbsc-factory.ts`   | BFF 側 DBSC ルートファクトリ |
| `packages/shared/src/lib/require-dbsc-bound.ts` | Phase 3 強制ミドルウェア     |
| `packages/shared/src/db/bff-sessions.ts`        | bff_sessions DB 操作         |
| `packages/shared/src/db/dbsc-challenges.ts`     | dbsc_challenges DB 操作      |
| `migrations/0024_bff_sessions_dbsc.sql`         | DBSC カラム追加              |
| `migrations/0025_dbsc_challenges.sql`           | チャレンジテーブル作成       |
