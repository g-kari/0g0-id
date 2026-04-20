# 0g0-id — 統合ID基盤（IdP）モノレポ

## アーキテクチャ

| Worker            | ドメイン      | 役割                                                         |
| ----------------- | ------------- | ------------------------------------------------------------ |
| `workers/id`      | id.0g0.xyz    | IdPコアAPI（認証・JWT・DB・トークン）                        |
| `workers/user`    | user.0g0.xyz  | ユーザー向けBFF（ログインUI・プロフィール）+ Astro SPA       |
| `workers/admin`   | admin.0g0.xyz | 管理画面BFF（サービス管理・ユーザー管理）+ Astro SPA         |
| `workers/mcp`     | mcp.0g0.xyz   | MCP Worker（Claude Code連携）                                |
| `packages/shared` | —             | 共通型定義・ライブラリ（直接ソース参照、ビルドステップなし） |

## 重要な設計

- JWT署名: **ES256**（jose + WebCrypto）、アクセストークン15分・リフレッシュトークン30日
- BFF → id: Service Bindings でサーバー間呼び出し、ワンタイム認可コード方式でトークン受け渡し
- トークンローテーション時の競合: `TOKEN_ROTATED` は並行リクエスト競合（セッション有効）→ 503で返しCookie削除不可

## BFF フロントエンド構成

user/admin Worker は **Hono（API） + Astro（UI）** のハイブリッド構成。

- フロントエンド: `workers/{user,admin}/frontend/` — Astro (pure static MPA) + Tailwind CSS v4
- ビルド: `astro build` → `workers/{user,admin}/dist/` に出力（各ルートが個別HTMLファイル）
- 静的アセット配信: **Cloudflare Workers Assets**（`[assets]` binding）
- SPA ルーティング: `not_found_handling = "single-page-application"` + `run_worker_first` で API/auth は Worker、`/_astro/*` 等の静的アセットは Assets が直接配信
- ページスクリプト: Astro `<script>` タグ内の vanilla TypeScript で API 呼び出し・DOM 操作

### ⚠️ 動的パス（詳細ページ）の実装ルール

一覧ページから `/resources/:id` へリンクする場合、**対応する `detail.astro` を必ず作成すること**。

- 配置: `workers/{user,admin}/frontend/src/pages/{resource}/detail.astro`
- ビルド出力: `/resource/detail/index.html` → SPA fallback で `/resource/:id` にマッチ
- IDの取得パターン（`detail.astro` の `<script>` 内）:
  ```typescript
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const id =
    new URLSearchParams(window.location.search).get("id") ||
    (pathParts.length >= 2 && pathParts[0] === "resource" ? pathParts[1] : null);
  ```
- 既存例: `users/detail.astro`, `services/detail.astro`
- **APIルートを追加したら、対応するフロントエンドの詳細ページも作成されているか確認すること**

## 開発コマンド

```bash
npx vp check          # lint + format + typecheck（コミット前に必須）
npx vp check --fix    # 自動修正
npx vp test run       # 全テスト実行
```

### フロントエンドビルド

```bash
cd workers/user/frontend && npm run build    # user SPA ビルド → ../dist/
cd workers/admin/frontend && npm run build   # admin SPA ビルド → ../dist/
```

### デプロイ

```bash
npm run deploy:user    # フロントエンドビルド + wrangler deploy
npm run deploy:admin
npm run deploy:id
npm run deploy:mcp
```

`deploy:user` / `deploy:admin` は `wrangler deploy` の前に `scripts/preflight-deploy.ts` を走らせ、`DBSC_ENFORCE_SENSITIVE` secret の登録有無を確認する。ローカル運用では warn のみで続行（fail-open）するが、**CI 経由のデプロイを追加する際は該当 job の `env:` に `PREFLIGHT_STRICT: "1"` を固定設定する**ことを推奨（issue #155 Phase 3 — secret 登録漏れの本番反映を防ぐ運用ゲート）。詳細は `docs/api-user.md` / `docs/api-admin.md` の「デプロイ運用」セクションを参照。

`deploy:id` の内部シークレット撤廃ゲート（issue #156 Phase 6）: id worker の secret `INTERNAL_SECRET_STRICT="true"` を設定すると、共有 `INTERNAL_SERVICE_SECRET` 経路を `403 DEPRECATED_INTERNAL_SECRET` で拒否する。未設定・その他値では従来通り warn-only。個別 `INTERNAL_SERVICE_SECRET_USER` / `_ADMIN` と Basic 認証は無影響。Phase 5 までの観測ログで残存呼び出し元を 0 にしてから strict 化する運用。詳細は `docs/api-id.md` の運用メモを参照。

`deploy:id` も `wrangler deploy` 前に `workers/id/scripts/preflight-deploy.ts` を走らせ、`INTERNAL_SECRET_STRICT` secret の登録有無を確認する（issue #156 Phase 7 — strict 化したつもりの設定漏れ検知）。さらに同スクリプトは `INTERNAL_SERVICE_SECRET_USER` / `INTERNAL_SERVICE_SECRET_ADMIN` の登録有無も確認する（issue #156 Phase 8 — strict モードで片方の BFF が 403 全壊する事故を事前検知）。ローカル運用では warn のみで続行（fail-open）、**CI 経由のデプロイを追加する際は該当 job の `env:` に `PREFLIGHT_STRICT: "1"` を固定設定する**ことを推奨。BFF 側の `DBSC_ENFORCE_SENSITIVE` プリフライトと同じ共通コア（`packages/shared/src/lib/preflight-core.ts`）を使用。secret 値は `"true"`・CI env は `"1"` の組み合わせで受理値が**逆向き**なので混同注意。詳細は `docs/api-id.md` の「デプロイ運用」セクションを参照。

### ⚠️ id worker の静的アセット生成

`deploy:id` は `build:assets` で `dist/.well-known/*.json` と `dist/docs/*.json` を生成し、Workers Assets 経由で配信する。公開鍵は以下の優先順で解決される:

1. `JWT_PUBLIC_KEY` env var（PEM） — ローカルで鍵を新規生成した直後に使う
2. リポジトリにコミットされた `workers/id/public-key.jwk.json`（JWK） — CI / 通常ビルド

**鍵ローテーション時は以下の両方を必ず更新すること**（JWKS が dist に固定化されるため、どちらか片方だけでは不整合が起きる）:

- `wrangler secret put JWT_PUBLIC_KEY`（Worker runtime 用）
- `workers/id/public-key.jwk.json` を新しい公開鍵の JWK に差し替えてコミット

```bash
# ローテーション時のみ: 新しい公開鍵 PEM を env に渡して反映を確認
export JWT_PUBLIC_KEY="$(cat path/to/id-pub.pem)"
npm run deploy:id
# public-key.jwk.json も忘れずに更新してコミット
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

| 操作                 | Serenaツール                                   |
| -------------------- | ---------------------------------------------- |
| シンボル検索         | `find_symbol`                                  |
| 参照先検索           | `find_referencing_symbols`                     |
| ディレクトリ一覧     | `list_dir`                                     |
| ファイル検索         | `find_file`                                    |
| ファイル読み取り     | `read_file`                                    |
| シンボル一覧         | `get_symbols_overview`                         |
| シンボル単位の編集   | `replace_symbol_body`                          |
| コンテンツ置換       | `replace_content`                              |
| 挿入（後/前）        | `insert_after_symbol` / `insert_before_symbol` |
| パターン検索         | `search_for_pattern`                           |
| ファイル作成・上書き | `create_text_file`                             |

**禁止（Serena利用可能時）:** `cat`, `sed`, `awk`, `grep`, `find` 等のシェルコマンド、行番号ベースの編集

**例外:** Serenaが未初期化・利用不可の場合のみ代替手段を使用可。
