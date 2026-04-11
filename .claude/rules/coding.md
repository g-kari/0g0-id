---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# コーディング規約

## TypeScript

- `strict: true` 必須
- `any` 型禁止（`unknown` を使用）
- 関数の戻り値型は明示
- Cloudflare Workers環境: `@cloudflare/workers-types` を使用

## Hono パターン

```typescript
// Bindings型を必ず指定
const app = new Hono<{ Bindings: IdpEnv }>();

// ルートハンドラーの型
app.get('/path', async (c): Promise<Response> => {
  return c.json({ data: ... });
});
```

## D1 クエリ

- 必ず Prepared Statements を使用

```typescript
const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
```

## エラーハンドリング

```typescript
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
});
```

## ライブラリ利用方針

**既存ライブラリがある場合は必ずライブラリを利用すること。独自実装するのはライブラリが存在しない場合のみ。**

- 暗号化・ハッシュ処理 → `jose`、WebCrypto API
- バリデーション → `zod`
- 日付処理 → `date-fns`
- HTTP通信 → HonoのビルトインAPIを優先
- テスト → `vitest`

車輪の再発明は禁止。まずnpmパッケージを検索・検討すること。

## コード修正後の確認

コード修正後は `/copilot-review` を実行してレビュー及びコードの修正を行うこと。
