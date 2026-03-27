# 0g0-id — 統合ID基盤（IdP）モノレポ

## アーキテクチャ
- **id.0g0.xyz** (`workers/id`) — IdPコアAPI（認証・JWT・DB・トークン）
- **user.0g0.xyz** (`workers/user`) — ユーザー向けBFF（ログインUI・プロフィール）
- **admin.0g0.xyz** (`workers/admin`) — 管理画面BFF（サービス管理・ユーザー管理）
- **packages/shared** — 共通型定義・ライブラリ（直接ソース参照、ビルドステップなし）

## ビルド・デプロイコマンド
```bash
npm install                    # 全workspace依存解決
npm run typecheck              # 全workspace型チェック
npm run dev:id                 # id worker開発サーバー（:8787）
npm run dev:user               # user worker開発サーバー（:8788）
npm run dev:admin              # admin worker開発サーバー（:8789）
npm run deploy:id              # id workerデプロイ
npm run deploy:user            # user workerデプロイ
npm run deploy:admin           # admin workerデプロイ
```

## マイグレーション

### ⚠️ 必須ルール: 新しいマイグレーションファイルを追加したら必ずローカルで本番DBに適用してからpushすること

マイグレーションを適用せずにデプロイすると、新カラムを参照するコードが本番で `D1_ERROR: no such column` を起こす。

```bash
# 本番DBに適用（push前に必ず実行）
npm run migrate:id
# = wrangler d1 migrations apply 0g0-id-db --yes

# ローカルDBに適用（開発時）
wrangler d1 migrations apply 0g0-id-db --local --yes
```

### デプロイの仕組み

Cloudflare CI でデプロイしている（GitHub Actions は使用しない）。

- **ビルドコマンド**: なし
- **デプロイコマンド**: `npm ci && npm run deploy:id`
- **ルートディレクトリ**: `/`

`deploy:id` スクリプトは `wrangler d1 migrations apply 0g0-id-db --yes && vite build && wrangler deploy` を実行する。
**非インタラクティブ環境（CI）では `--yes` フラグが必須**。このフラグがないと確認プロンプトが応答されず、マイグレーションが適用されないままデプロイが進む恐れがある。

### マイグレーションファイル追加時のチェックリスト

1. `migrations/XXXX_*.sql` を作成
2. **本番DBに適用**: `npm run migrate:id`（ローカルマシンから）
3. コードを変更（新カラムを使用）
4. `npm run typecheck` で型チェック
5. `git push`（CIが自動デプロイ）

## シークレット管理
`.dev.vars`（gitignore済み）をworkers/id/に配置:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
JWT_PRIVATE_KEY=...（ES256秘密鍵PEM）
JWT_PUBLIC_KEY=...（ES256公開鍵PEM）
BOOTSTRAP_ADMIN_EMAIL=...（初回のみ）
```

## JWT署名方式
- アルゴリズム: **ES256**（jose + WebCrypto）
- 公開鍵: `/.well-known/jwks.json` で公開
- 有効期限: アクセストークン15分、リフレッシュトークン30日

## BFF認証ハンドオフ
BFF（user/admin）はブラウザと直接通信。idへはService Bindingsでサーバー間呼び出し。
ワンタイム認可コード方式でトークンを受け渡す。

## 開発ツール

### ⚠️ Serena（セマンティックコーディングMCP）— 必須ツール

> **このプロジェクトでは、コードの読み取り・検索・編集にSerenaを必ず利用すること。**
> **SerenaのMCPツールが利用可能であれば、他の手段（Read/Edit/Grep/Glob等）の使用は禁止。**

SerenaはLanguage Serverを活用したセマンティックコーディングツールです。
以下の場面でSerenaのツールを積極的に使用してください：

| 操作 | 使用するSerenaツール |
|------|---------------------|
| シンボルの検索 | `find_symbol` |
| シンボルの参照先検索 | `find_referencing_symbols` |
| ディレクトリ一覧 | `list_dir` |
| ファイル検索 | `find_file` |
| コード読み取り | `read_file` |
| シンボル一覧取得 | `get_symbols_overview` |
| シンボル単位の編集 | `replace_symbol_body` |
| コードの挿入（後） | `insert_after_symbol` |
| コードの挿入（前） | `insert_before_symbol` |
| パターン検索 | `search_for_pattern` |
| ファイル作成・上書き | `create_text_file` |

**禁止事項（SerenaのMCPツールが使える場合）:**
- `cat`, `sed`, `awk`, `grep`, `find` 等のシェルコマンドによるファイル操作
- Claude Code組み込みのRead/Edit/Grep/Glob ツールによるファイル操作
- 行番号ベースの編集（シンボル単位の編集を優先）

**例外:** Serenaのセッションが未初期化・ツールが利用不可の場合のみ、代替手段を使用可。

## コード規約

### ライブラリ利用方針
**既存ライブラリがある場合は必ずライブラリを利用すること。独自実装するのはライブラリが存在しない場合のみ。**

- 暗号化・ハッシュ処理 → `jose`、WebCrypto API
- バリデーション → 専用ライブラリを使用（zod等）
- 日付処理 → `date-fns`等のライブラリを使用
- HTTP通信 → HonoのビルトインAPIを優先
- テスト → `vitest`を使用

車輪の再発明は禁止。まずnpmパッケージを検索・検討すること。

## コミットメッセージ規約
日本語で記述: `機能追加: 〇〇`, `バグ修正: 〇〇`, `リファクタリング: 〇〇`
