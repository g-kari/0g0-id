---
paths:
  - "workers/user/frontend/**"
  - "workers/admin/frontend/**"
---

# デザイン規約

## デザインシステム

katasu.me インスパイアの温かみのある低彩度ブラウン系パレット（user/admin 共通）。
フォント: Reddit Sans + IBM Plex Sans JP（Google Fonts @import）

## CSS 変数

```css
--color-bg: #fefbfb; /* ページ背景・カード背景 */
--color-text: #483030; /* 本文・見出し・プライマリボタン背景 */
--color-muted: #a39696; /* サブテキスト・ラベル */
--color-border: #dfd7d7; /* ボーダー・区切り線 */
--color-surface: #f2f0f0; /* 入力フィールド背景・ホバー背景 */
--color-accent: #73862d; /* アクセント（オリーブグリーン）・フォーカス */
--color-danger: #c0392b; /* 削除・エラー */
--color-success: #2d7a3a; /* 成功 */
```

## アニメーション

```css
--ease: cubic-bezier(0.16, 1, 0.3, 1);
--transition: all 0.4s var(--ease);
--radius: 12px;
--radius-sm: 8px;
```

## コンポーネントスタイル

```css
/* プライマリボタン */
.btn-primary {
  background: var(--color-text);
  color: var(--color-bg);
  border-radius: var(--radius-sm);
  font-weight: 500;
}

/* カード */
.card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 2rem;
}
```

## フロントエンド技術スタック

- **SvelteKit** + **Svelte 5**（runes モード）
- **Tailwind CSS v4**（`@tailwindcss/vite` プラグイン）
- **@sveltejs/adapter-static** — 静的 SPA として Cloudflare Workers Assets にデプロイ
- SPA fallback: `index.html`（Cloudflare Workers Assets の `not_found_handling = "single-page-application"` に準拠）

## レイアウト方針

- レスポンシブ対応（モバイルファースト）
- シンプルで機能的なUI
- SvelteKit のルーティング・レイアウト機能を活用

## アクセシビリティ

- `aria-*` 属性を適切に使用
- フォームラベルは必ず `<label>` で関連付け
- キーボード操作対応
