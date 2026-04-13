# 0g0-id — 統合ID基盤（IdP）モノレポ

## アーキテクチャ

| Worker | ドメイン | 役割 |
|--------|----------|------|
| `workers/id` | id.0g0.xyz | IdPコアAPI（認証・JWT・DB・トークン） |
| `workers/user` | user.0g0.xyz | ユーザー向けBFF（ログインUI・プロフィール） |
| `workers/admin` | admin.0g0.xyz | 管理画面BFF（サービス管理・ユーザー管理） |
| `workers/mcp` | mcp.0g0.xyz | MCP Worker |
| `packages/shared` | — | 共通型定義・ライブラリ（直接ソース参照、ビルドステップなし） |

## 重要な設計

- JWT署名: **ES256**（jose + WebCrypto）、アクセストークン15分・リフレッシュトークン30日
- BFF → id: Service Bindings でサーバー間呼び出し、ワンタイム認可コード方式でトークン受け渡し
- トークンローテーション時の競合: `TOKEN_ROTATED` は並行リクエスト競合（セッション有効）→ 503で返しCookie削除不可

## 開発コマンド

```bash
npx vp check          # lint + format + typecheck（コミット前に必須）
npx vp check --fix    # 自動修正
npx vp test run       # 全テスト実行
```

## マイグレーション

### ⚠️ 必須: 新しいマイグレーションファイルを追加したら必ずpush前に本番DBへ適用すること

適用せずデプロイすると `D1_ERROR: no such column` が本番で発生する。

```bash
npm run migrate:id    # 本番DBに適用（push前に必ず実行）
```

## 開発ツール

### ⚠️ Serena（セマンティックコーディングMCP）— 必須ツール

> **コードの読み取り・検索・編集には必ずSerenaを使うこと。**
> **SerenaのMCPツールが利用可能な場合、Read/Edit/Grep/Glob等の使用は禁止。**

| 操作 | Serenaツール |
|------|-------------|
| シンボル検索 | `find_symbol` |
| 参照先検索 | `find_referencing_symbols` |
| ディレクトリ一覧 | `list_dir` |
| ファイル検索 | `find_file` |
| ファイル読み取り | `read_file` |
| シンボル一覧 | `get_symbols_overview` |
| シンボル単位の編集 | `replace_symbol_body` |
| コンテンツ置換 | `replace_content` |
| 挿入（後/前） | `insert_after_symbol` / `insert_before_symbol` |
| パターン検索 | `search_for_pattern` |
| ファイル作成・上書き | `create_text_file` |

**禁止（Serena利用可能時）:** `cat`, `sed`, `awk`, `grep`, `find` 等のシェルコマンド、行番号ベースの編集

**例外:** Serenaが未初期化・利用不可の場合のみ代替手段を使用可。
