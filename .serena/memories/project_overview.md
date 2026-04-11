---
name: project_overview
description: 0g0-id プロジェクト概要、技術スタック、アーキテクチャ
type: project
---

## プロジェクト: 0g0-id（統合ID基盤 IdP モノレポ）

Cloudflare Workers + Hono + TypeScript + D1(SQLite) で構築されたOAuth2/OIDC準拠のIdP。

### ワークスペース構成

- `workers/id` → IdPコアAPI（:8787）認証・JWT・DB・トークン
- `workers/user` → ユーザー向けBFF（:8788）ログインUI・プロフィール
- `workers/admin` → 管理画面BFF（:8789）サービス管理・ユーザー管理
- `packages/shared` → 共通型定義・ライブラリ（ビルドステップなし、直接ソース参照）

### 技術スタック

- Cloudflare Workers（Wrangler）
- Hono フレームワーク
- TypeScript
- D1（SQLite互換）データベース
- JWT/ES256（jose + WebCrypto）
- vitest テストフレームワーク
- zod バリデーション

### 認証フロー

- OAuthプロバイダー: Google（必須）、LINE・Twitch・GitHub・X（オプション）
- BFF認証: ワンタイム認可コード → Service Bindingsでサーバー間呼び出し
- JWT: ES256、アクセストークン15分・リフレッシュトークン30日
