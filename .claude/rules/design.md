---
paths:
  - "workers/user/**"
  - "workers/admin/**"
---

# デザイン規約

## カラーパレット

### 管理画面（admin.0g0.xyz）

- プライマリ: `#1e40af`（深いブルー）
- セカンダリ: `#1e293b`（ダークネイビー）
- 背景: `#f8fafc`
- テキスト: `#0f172a`
- アクセント: `#3b82f6`

### ユーザー画面（user.0g0.xyz）

- プライマリ: `#6d28d9`（パープル）
- セカンダリ: `#4c1d95`
- 背景: `#fafafa`
- テキスト: `#111827`
- アクセント: `#8b5cf6`

## レイアウト方針

- レスポンシブ対応（モバイルファースト）
- シンプルで機能的なUI
- 最小限のJavaScript（Vanilla JS、フレームワーク不使用）
- CDNからのライブラリ読み込み禁止（セキュリティ上の理由）

## コンポーネントスタイル

```css
/* ボタン */
.btn-primary {
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  font-weight: 500;
}

/* カード */
.card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  padding: 1.5rem;
}
```

## アクセシビリティ

- `aria-*` 属性を適切に使用
- フォームラベルは必ず `<label>` で関連付け
- キーボード操作対応
