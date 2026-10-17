# D1 バックアップ・災害復旧手順

0g0-id の D1 データベース（`0g0-id-db`）のバックアップ戦略と災害復旧手順。

## データベース情報

| 項目             | 値                                 |
| ---------------- | ---------------------------------- |
| Database Name    | `0g0-id-db`                        |
| Binding          | `DB`                               |
| Worker           | `id`（`workers/id/wrangler.toml`） |
| マイグレーション | `migrations/` 配下（27 ファイル）  |

---

## 1. バックアップ

### 1.1 手動エクスポート（wrangler d1 export）

```bash
# SQL ダンプを取得
wrangler d1 export 0g0-id-db --remote --output backup-$(date +%Y%m%d).sql

# 特定テーブルのみ
wrangler d1 export 0g0-id-db --remote --table users --output users-$(date +%Y%m%d).sql
```

**推奨頻度**: デプロイ前・鍵ローテーション前・週次

### 1.2 D1 Time Travel（自動スナップショット）

D1 は内部的に自動バックアップを保持しており、過去 30 日間の任意の時点にリストア可能（Workers Paid プラン）。

```bash
# ブックマークを作成（復旧ポイントのラベル付け）
wrangler d1 time-travel bookmark create 0g0-id-db --remote --message "pre-deploy-20260423"

# ブックマーク一覧
wrangler d1 time-travel bookmark list 0g0-id-db --remote

# 特定時点にリストア
wrangler d1 time-travel restore 0g0-id-db --remote --bookmark <bookmark-id>

# タイムスタンプ指定でリストア
wrangler d1 time-travel restore 0g0-id-db --remote --timestamp 2026-04-23T10:00:00Z
```

### 1.3 バックアップ保存先

| 保存先        | 用途                     |
| ------------- | ------------------------ |
| ローカル      | 開発者の手元に即時保存   |
| R2 バケット   | 長期保存・チーム共有     |
| Git（非推奨） | SQL ダンプは含めないこと |

R2 へのアップロード例:

```bash
wrangler d1 export 0g0-id-db --remote --output /tmp/backup.sql
wrangler r2 object put 0g0-id-backups/backup-$(date +%Y%m%d).sql --file /tmp/backup.sql
rm /tmp/backup.sql
```

---

## 2. 復旧手順

### 2.1 Time Travel によるリストア（推奨）

データ破損・誤操作から 30 日以内であれば Time Travel が最も安全。

```bash
# 1. 直前のブックマークを確認
wrangler d1 time-travel bookmark list 0g0-id-db --remote

# 2. リストア実行
wrangler d1 time-travel restore 0g0-id-db --remote --bookmark <bookmark-id>

# 3. リストア後の確認
wrangler d1 execute 0g0-id-db --remote --command "SELECT COUNT(*) FROM users"
```

### 2.2 SQL ダンプからのリストア

Time Travel が使えない場合（30 日超過、DB 再作成など）。

```bash
# 1. 新しい D1 データベースを作成（既存が破損している場合）
wrangler d1 create 0g0-id-db-restored

# 2. マイグレーションを適用
wrangler d1 migrations apply 0g0-id-db-restored --remote

# 3. データをインポート（スキーマを除いたデータのみ）
wrangler d1 execute 0g0-id-db-restored --remote --file backup.sql

# 4. wrangler.toml の database_id を新しい DB に更新
# 5. 再デプロイ
npm run deploy:id
```

### 2.3 マイグレーション整合性の確認

リストア後、マイグレーション状態が正しいことを確認する。

```bash
# 適用済みマイグレーションの確認
wrangler d1 migrations list 0g0-id-db --remote

# 未適用のマイグレーションがあれば適用
npm run migrate:id
```

### 2.4 復旧後のトークン無効化

復旧時点によっては、リストア後のデータベース状態と発行済みトークンに不整合が生じる。

**全セッション強制失効が必要なケース:**

- リストア先が数時間以上前の時点 → リストア後に発行されたリフレッシュトークンが DB に存在しない
- `refresh_tokens` テーブルの `revoked_at` が巻き戻る → 失効済みトークンが有効に見える
- `bff_sessions` テーブルの状態が巻き戻る → BFF セッションの不整合

**強制失効の実行:**

```bash
# 全リフレッシュトークンを失効
wrangler d1 execute 0g0-id-db --remote --command \
  "UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = 'security_event' WHERE revoked_at IS NULL"

# 全 BFF セッションを失効
wrangler d1 execute 0g0-id-db --remote --command \
  "UPDATE bff_sessions SET revoked_at = unixepoch(), revoked_reason = 'security_event' WHERE revoked_at IS NULL"

# revoked_access_tokens のクリーンアップ（期限切れ分の削除）
wrangler d1 execute 0g0-id-db --remote --command \
  "DELETE FROM revoked_access_tokens WHERE expires_at < unixepoch()"
```

アクセストークンは 15 分で期限切れのため、上記でリフレッシュトークンを失効させれば 15 分以内に全ユーザーが再ログインを求められる。

---

## 3. 鍵ローテーション時の復旧

### 3.1 JWT 秘密鍵紛失時の対応

秘密鍵が紛失・漏洩した場合、全トークンを無効化して鍵を再生成する必要がある。

```bash
# 1. 新しい ES256 鍵ペアを生成
openssl ecparam -genkey -name prime256v1 -noout -out id-priv.pem
openssl ec -in id-priv.pem -pubout -out id-pub.pem

# 2. Cloudflare に新しい秘密鍵を登録
wrangler secret put JWT_PRIVATE_KEY -c workers/id/wrangler.toml < id-priv.pem
wrangler secret put JWT_PUBLIC_KEY -c workers/id/wrangler.toml < id-pub.pem

# 3. public-key.jwk.json を更新
#    新しい公開鍵の JWK を生成して workers/id/public-key.jwk.json を差し替え
#    ※ jose ライブラリや https://jwkset.com/generate などで PEM → JWK 変換

# 4. 全トークンを失効（旧鍵で署名されたトークンは検証失敗するが、明示的に失効させる）
wrangler d1 execute 0g0-id-db --remote --command \
  "UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = 'security_event' WHERE revoked_at IS NULL"
wrangler d1 execute 0g0-id-db --remote --command \
  "UPDATE bff_sessions SET revoked_at = unixepoch(), revoked_reason = 'security_event' WHERE revoked_at IS NULL"

# 5. 静的アセットを再ビルド（JWKS エンドポイント更新）して再デプロイ
npm run deploy:id

# 6. 秘密鍵ファイルを安全に削除
shred -u id-priv.pem id-pub.pem
```

### 3.2 public-key.jwk.json と wrangler secret の整合性確認

JWKS エンドポイント（`/.well-known/jwks.json`）の公開鍵と、Worker が署名に使う秘密鍵が対応していることを確認する。

```bash
# JWKS エンドポイントの公開鍵を取得
curl -s https://id.0g0.xyz/.well-known/jwks.json | jq .

# リポジトリの公開鍵と比較
cat workers/id/public-key.jwk.json | jq .

# 不一致の場合:
# - public-key.jwk.json を現在の JWT_PUBLIC_KEY に合わせて更新
# - npm run deploy:id で再デプロイ
```

**整合性が崩れるケース:**

| 状況                        | 症状                                       | 対処                                 |
| --------------------------- | ------------------------------------------ | ------------------------------------ |
| secret のみ更新、JWK 未更新 | JWKS に古い公開鍵 → 外部サービスが検証失敗 | JWK を更新して再デプロイ             |
| JWK のみ更新、secret 未更新 | 署名と公開鍵が不一致 → 全トークン検証失敗  | secret を更新して再デプロイ          |
| 片方の BFF の secret 未更新 | 該当 BFF が 403 全壊                       | `INTERNAL_SERVICE_SECRET_*` を再設定 |

---

## 4. 復旧チェックリスト

障害発生時に順に確認する。

- [ ] D1 データベースの状態確認（`wrangler d1 execute ... "SELECT COUNT(*) FROM users"`）
- [ ] Time Travel で復旧可能か確認（30 日以内か）
- [ ] バックアップ SQL の有無確認
- [ ] マイグレーション整合性の確認（`wrangler d1 migrations list`）
- [ ] トークン無効化の要否判断（巻き戻し時間が数時間以上なら必須）
- [ ] JWKS 整合性の確認（鍵ローテーション関連の場合）
- [ ] 全 Worker の再デプロイ（id → user/admin → mcp の順）
- [ ] エンドポイントの疎通確認（`curl https://id.0g0.xyz/health`）
- [ ] ログイン動作の確認
