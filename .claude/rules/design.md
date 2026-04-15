---
paths:
  - "workers/user/frontend/**"
  - "workers/admin/frontend/**"
---

# デザイン規約

## デザインシステム

katasu.me インスパイアの温かみのある低彩度ブラウン系パレット（user/admin 共通）。
フォント: Reddit Sans + IBM Plex Sans JP（Google Fonts）

## CSS 変数（Tailwind CSS v4 @theme）

```css
--color-bg: #fefbfb;
--color-text: #483030;
--color-muted: #a39696;
--color-border: #dfd7d7;
--color-surface: #f2f0f0;
--color-accent: #73862d;
--color-danger: #c0392b;
--color-success: #2d7a3a;
```

## フロントエンド技術スタック

- **Astro** — pure static MPA（`output: 'static'`）、@astrojs/cloudflare アダプター不使用
- **Tailwind CSS v4** — `@tailwindcss/vite` プラグイン
- **vanilla TypeScript** — `<script>` タグ内で API 呼び出し・DOM 操作
- ビルド出力: `../dist/` → Cloudflare Workers Assets が配信
- 静的アセット: `/_astro/*`（Workers Assets が直接配信、Worker を経由しない）

## ページ構成パターン

```astro
---
import Base from '../layouts/Base.astro';
---
<Base title="ページタイトル">
  <div id="loading">...</div>
  <div id="content" style="display:none">...</div>
</Base>

<script>
  import { apiFetch } from '../lib/api';
  // DOM操作でデータ表示
</script>
```

## レイアウト

- `Base.astro` — HTML shell（Google Fonts, app.css, toast container）
- `Admin.astro`（admin のみ）— Base 拡張 + サイドバーナビゲーション

## アクセシビリティ

- `aria-*` 属性を適切に使用
- フォームラベルは必ず `<label>` で関連付け
- キーボード操作対応
