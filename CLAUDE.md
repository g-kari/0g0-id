# 0g0-id — 統合ID基盤（IdP）モノレポ

## アーキテクチャ

- **id.0g0.xyz** (`workers/id`) — IdPコアAPI（認証・JWT・DB・トークン）
- **user.0g0.xyz** (`workers/user`) — ユーザー向けBFF（ログインUI・プロフィール）
- **admin.0g0.xyz** (`workers/admin`) — 管理画面BFF（サービス管理・ユーザー管理）
- **mcp.0g0.xyz** (`workers/mcp`) — MCP Worker
- **packages/shared** — 共通型定義・ライブラリ（直接ソース参照、ビルドステップなし）

## マイグレーション

### ⚠️ 必須ルール: 新しいマイグレーションファイルを追加したら必ずローカルで本番DBに適用してからpushすること

マイグレーションを適用せずにデプロイすると、新カラムを参照するコードが本番で `D1_ERROR: no such column` を起こす。

```bash
# 本番DBに適用（push前に必ず実行）
npm run migrate:id
```

## JWT / BFF

- JWT署名: **ES256**（jose + WebCrypto）、アクセストークン15分・リフレッシュトークン30日
- BFF（user/admin）→ id へは Service Bindings でサーバー間呼び出し、ワンタイム認可コード方式でトークン受け渡し

## 開発ツール

### ⚠️ Serena（セマンティックコーディングMCP）— 必須ツール

> **このプロジェクトでは、コードの読み取り・検索・編集にSerenaを必ず利用すること。**
> **SerenaのMCPツールが利用可能であれば、他の手段（Read/Edit/Grep/Glob等）の使用は禁止。**

| 操作                 | 使用するSerenaツール       |
| -------------------- | -------------------------- |
| シンボルの検索       | `find_symbol`              |
| シンボルの参照先検索 | `find_referencing_symbols` |
| ディレクトリ一覧     | `list_dir`                 |
| ファイル検索         | `find_file`                |
| コード読み取り       | `read_file`                |
| シンボル一覧取得     | `get_symbols_overview`     |
| シンボル単位の編集   | `replace_symbol_body`      |
| コードの挿入（後）   | `insert_after_symbol`      |
| コードの挿入（前）   | `insert_before_symbol`     |
| パターン検索         | `search_for_pattern`       |
| ファイル作成・上書き | `create_text_file`         |

**禁止事項（SerenaのMCPツールが使える場合）:**

- `cat`, `sed`, `awk`, `grep`, `find` 等のシェルコマンドによるファイル操作
- Claude Code組み込みのRead/Edit/Grep/Glob ツールによるファイル操作
- 行番号ベースの編集（シンボル単位の編集を優先）

**例外:** Serenaのセッションが未初期化・ツールが利用不可の場合のみ、代替手段を使用可。
