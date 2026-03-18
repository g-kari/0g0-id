---
name: deploy
description: Cloudflare Workersへのデプロイ
disable-model-invocation: true
---

# デプロイスキル

引数に `id`, `user`, `admin` のいずれかを指定してデプロイを実行します。

## 使用方法
- `/deploy id` — id worker をデプロイ
- `/deploy user` — user worker をデプロイ
- `/deploy admin` — admin worker をデプロイ

## 実行コマンド
```bash
# /deploy id
npm run deploy:id

# /deploy user
npm run deploy:user

# /deploy admin
npm run deploy:admin
```

デプロイ前に `npm run typecheck` で型チェックを実行してください。
