---
name: suggested_commands
description: 開発・テスト・デプロイコマンド一覧
type: project
---

## 開発サーバー起動

```bash
npm run dev:id    # IdP worker (:8787)
npm run dev:user  # user BFF (:8788)
npm run dev:admin # admin BFF (:8789)
```

## テスト

```bash
npm run test                        # 全テスト
npm run test -w workers/id          # IdPのみ
npm run test -w packages/shared     # sharedのみ
```

## 型チェック

```bash
npm run typecheck   # 全ワークスペース一括
```

## マイグレーション

```bash
npm run migrate:id  # 本番DBに適用（--remote フラグ付き）
wrangler d1 migrations apply 0g0-id-db --local   # ローカルのみ
```

## デプロイ

```bash
npm run deploy:id
npm run deploy:user
npm run deploy:admin
```
