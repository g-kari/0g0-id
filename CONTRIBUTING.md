# Contributing — 0g0-id

0g0-id へのコントリビューションを歓迎します。
本ドキュメントは、リポジトリへのパッチ提出・レビュー・運用に必要な規約と手順をまとめたものです。

> 既存の規約・設計思想の詳細は以下も参照してください。
>
> - [README.md](./README.md)
> - [CLAUDE.md](./CLAUDE.md)
> - [.claude/rules/coding.md](./.claude/rules/coding.md)
> - [.claude/rules/design.md](./.claude/rules/design.md)
> - [.claude/rules/security.md](./.claude/rules/security.md)
> - [.claude/rules/api.md](./.claude/rules/api.md)
> - [.claude/rules/git.md](./.claude/rules/git.md)

---

## 1. 開発フロー

### 1.1 ブランチ戦略

- ベースブランチは `master`
- 作業ブランチは目的に応じて prefix を付与:
  - `feature/<topic>` — 新機能
  - `fix/<topic>` — バグ修正
  - `refactor/<topic>` — リファクタリング
  - `docs/<topic>` — ドキュメント整備
  - `security/<topic>` — セキュリティ対応
- 1 つの PR は 1 つのトピックに絞る

### 1.2 コミットメッセージ規約

`.claude/rules/git.md` に従い、**日本語**で記述します。

```
機能追加: 〇〇
バグ修正: 〇〇
リファクタリング: 〇〇
ドキュメント整備: 〇〇
セキュリティ対応: 〇〇
```

例:

```
バグ修正: banUser/role_change の副作用をD1 batch()でアトミック化 (#137)
リファクタリング: 監査ログ生成ロジックを共通ヘルパー化 (#135)
```

関連 issue がある場合は末尾に `(#番号)` を付けるとトラッキングしやすくなります。

### 1.3 Serena 必須利用ルール

このリポジトリではコードの読み取り・検索・編集に **Serena（セマンティックコーディング MCP）** の使用を必須としています（CLAUDE.md 参照）。

| 操作                 | Serena ツール                                  |
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

Serena が利用可能な場合、`cat` / `sed` / `awk` / `grep` / `find` 等のシェルコマンドや行番号ベースの編集は使用しないでください。

---

## 2. 事前チェック

### 2.1 必須チェック（コミット前）

```bash
npx vp check          # lint + format + typecheck
npx vp check --fix    # 自動修正
npx vp test run       # 全テスト
```

`vp` は [Vite+](https://vite.plus) の統合 CLI で、Oxlint・Oxfmt・tsgolint・Vitest をまとめて実行します。

`.vite-hooks/pre-commit` で `vp staged` が自動実行され、ステージ済み TypeScript/JavaScript ファイルに対して `vp check --fix` が走ります。

### 2.2 フロントエンドビルド確認

user / admin の Astro フロントエンドを変更した場合は、ビルドが通ることを確認します。

```bash
cd workers/user/frontend && npm run build
cd workers/admin/frontend && npm run build
```

ビルド成果物は `workers/{user,admin}/dist/` に出力されます（`.gitignore` 済み）。

### 2.3 CI

`.github/workflows/ci.yml` が `master` への push および PR 時に以下を実行します。

- `vp check` — lint + format + typecheck
- `vp test run` — 全テスト

ローカルで通っても CI で fail する場合があるため、PR 作成後は CI 結果も確認してください。

---

## 3. 新規 API 追加時の整備手順

### 3.1 ルート追加

新しいエンドポイントは `workers/id/src/routes/` 配下に Hono の `app.METHOD(path, handler)` として実装します。

```typescript
const app = new Hono<{ Bindings: IdpEnv }>();
app.get("/api/example", async (c): Promise<Response> => {
  return c.json({ ok: true });
});
```

### 3.2 OpenAPI スキーマ更新（必須）

API を追加・変更・削除した場合は、**同じコミットで** OpenAPI スキーマも更新します。

| 変更内容                                                                     | 更新対象                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| id worker の内部 API（`/api/users`, `/api/services` など）の追加・変更       | `workers/id/src/routes/openapi/internal-spec.ts` |
| 外部向け API（`/api/external/`, `/api/userinfo`, `/auth/` など）の追加・変更 | `workers/id/src/routes/openapi/external-spec.ts` |
| 新スキーマ型の追加                                                           | 上記いずれか／両方の `components.schemas`        |
| API 削除                                                                     | 対応する `paths` エントリを削除                  |

スキーマ未更新で API を変更すると `/docs` の表示と実装が乖離するため、レビューでブロックされます。

### 3.3 エラーレスポンス形式

`.claude/rules/api.md` に従い、エンドポイントに応じて 2 種類を使い分けます。

- **REST 形式**（`/api/*`, `/auth/exchange` など）— `restErrorBody(code, message)`
  ```json
  { "error": { "code": "ERROR_CODE", "message": "説明" } }
  ```
- **OAuth 2.0 形式**（`/api/token/*`, `/auth/authorize`, `/api/userinfo` など）— `oauthErrorBody(error, description?)`
  ```json
  { "error": "invalid_request", "error_description": "説明" }
  ```

ヘルパーは `packages/shared/src/lib/errors.ts` からエクスポートされています。

### 3.4 動的パスのフロントエンド詳細ページ（必須）

一覧ページから `/resources/:id` 形式の URL へリンクする API を追加した場合、**対応する `detail.astro` を必ず作成してください**（CLAUDE.md 参照）。

- 配置: `workers/{user,admin}/frontend/src/pages/{resource}/detail.astro`
- ビルド出力: `/resource/detail/index.html` → SPA fallback で `/resource/:id` にマッチ
- ID の取得パターン:

  ```typescript
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const id =
    new URLSearchParams(window.location.search).get("id") ||
    (pathParts.length >= 2 && pathParts[0] === "resource" ? pathParts[1] : null);
  ```

- 既存例: `workers/admin/frontend/src/pages/users/detail.astro`, `workers/admin/frontend/src/pages/services/detail.astro`

### 3.5 テスト

ルートと同階層に `*.test.ts` を作成し、Vitest で記述します。

```typescript
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    findUserById: vi.fn(),
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});
```

実行:

```bash
npx vp test run
```

既存テスト一覧は `workers/id/src/routes/*.test.ts`、`workers/id/src/middleware/*.test.ts` を参考にしてください。

---

## 4. マイグレーション管理

### 4.1 ⚠️ push 前の本番適用は必須

新しいマイグレーションファイルを追加した場合、**push する前に必ず本番 D1 へ適用してください**。

```bash
npm run migrate:id
```

実体は `wrangler d1 migrations apply 0g0-id-db --remote`。

適用せずデプロイすると、本番で以下のエラーが発生します:

```
D1_ERROR: no such column
```

### 4.2 マイグレーションファイルの命名

`migrations/NNNN_description.sql` 形式（4 桁連番）。

例:

```
migrations/0021_user_profile_avatar.sql
migrations/0022_auth_codes_provider.sql
```

連番は既存ファイルの次の番号を使用します（`migrations/` を `ls` して確認）。

### 4.3 推奨フロー

1. `migrations/NNNN_*.sql` を作成
2. ローカルで動作確認（`npx wrangler d1 execute 0g0-id-db --local --file=...`）
3. `npm run migrate:id` で本番 D1 に適用
4. アプリ側のクエリ修正をコミット
5. `npm run deploy:id` でデプロイ

---

## 5. PR レビュー観点チェックリスト

レビュアー・作成者の双方が以下を確認してください。

### 5.1 共通

- [ ] `npx vp check` がエラー 0 で完了している
- [ ] `npx vp test run` が全件 pass している
- [ ] CI（`.github/workflows/ci.yml`）が green
- [ ] コミットメッセージが日本語規約に準拠している
- [ ] 1 PR = 1 トピックに絞られている

### 5.2 API 変更時

- [ ] 対応する OpenAPI スキーマ（`internal-spec.ts` / `external-spec.ts`）が更新されている
- [ ] エラーレスポンスが REST 形式 / OAuth 2.0 形式の使い分けに従っている
- [ ] `/api/resources/:id` 形式の追加に対し、`detail.astro` が作成されている

### 5.3 セキュリティ観点

`.claude/rules/security.md` に基づき、以下を確認します。

- [ ] JWT は **ES256** で署名され、`kid` がヘッダーに含まれている（HS256 禁止）
- [ ] Cookie は `__Host-` prefix + `HttpOnly` + `Secure` + `SameSite=Lax`
- [ ] 変更系エンドポイントに Origin 検証 / CSRF 対策が入っている
- [ ] OAuth フローで **state + PKCE (S256)** が必須化されている
- [ ] redirect_uri は完全一致で検証されている
- [ ] 管理者判定は DB の `role` フィールドベース（`ADMIN_EMAIL` 判定の追加は禁止）
- [ ] 機微情報（`client_secret`, `refresh_token` など）はハッシュ（SHA-256）で保存されている
- [ ] リフレッシュトークンのローテーション・reuse detection が壊れていない

### 5.4 監査ログの追加

管理者操作・破壊的操作を追加した場合、`workers/id/src/lib/audit.ts` の `AuditAction` 型に値を追加し、操作時に監査ログを記録してください。

既存のアクション例:

- `user.role_change`, `user.ban`, `user.unban`, `user.session_revoked`, `user.delete`
- `service.create`, `service.update`, `service.delete`, `service.secret_rotated`, `service.owner_transferred`

複数の DB 操作を伴う管理者操作は、D1 の `batch()` でアトミックに実行することが推奨されます（参考: PR #137）。

### 5.5 テスト追加

- [ ] 新規ルート・ヘルパーに対応する `*.test.ts` が追加されている
- [ ] バグ修正には再発防止のテストが含まれている
- [ ] エッジケース（未認証、権限不足、不正な入力、競合状態）がカバーされている

### 5.6 マイグレーション

- [ ] `migrations/NNNN_*.sql` を追加した場合、`npm run migrate:id` で本番適用済みである
- [ ] スキーマ変更が破壊的な場合、ロールバック手順が PR 説明に記載されている

---

## 6. 質問・相談

不明点は GitHub Issue で `question` ラベルを付けて起票してください。設計判断を伴う変更は、実装前に Issue で方針を相談すると無駄が少なくなります。
