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
```bash
# ローカル
wrangler d1 execute 0g0-id-db --local --file=migrations/0001_initial.sql
# 本番
wrangler d1 execute 0g0-id-db --file=migrations/0001_initial.sql
```

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

### Serena（セマンティックコーディングMCP）
**このプロジェクトではコード編集にSerenaを必ず利用すること。**

SerenaはLanguage Serverを活用したセマンティックコーディングツールです。
以下の場面でSerenaのツールを積極的に使用してください：

- シンボルの検索・参照 → `find_symbol`, `find_referencing_symbols`
- ファイル・ディレクトリ一覧 → `list_dir`, `find_file`
- コード読み取り → `read_file`, `get_symbols_overview`
- シンボル単位の編集 → `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`
- パターン検索 → `search_for_pattern`
- ファイル全体の作成・上書き → `create_text_file`

直接ファイル操作（cat, sed, awk等）よりSerenaのツールを優先すること。
シンボル単位の精密な編集が可能なため、大きなファイルでも効率的に作業できます。

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
