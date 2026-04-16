# 0g0-id ドキュメント

統合 ID 基盤（IdP）モノレポの仕様書一覧。

## API 仕様書

| ファイル                         | 対象                            | 概要                                                                              |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| [api-id.md](./api-id.md)         | `id.0g0.xyz`（id Worker）       | IdP コア API（認証 / JWT / OIDC / OAuth 2.0 / 外部連携 / ユーザー・サービス管理） |
| [api-user.md](./api-user.md)     | `user.0g0.xyz`（user Worker）   | ユーザー向け BFF（セッション Cookie ベース、id Worker へのプロキシ）              |
| [api-admin.md](./api-admin.md)   | `admin.0g0.xyz`（admin Worker） | 管理者向け BFF（admin ロール必須、サービス・ユーザー管理・メトリクス）            |
| [mcp-server.md](./mcp-server.md) | `mcp.0g0.xyz`（mcp Worker）     | Model Context Protocol ツール仕様（Claude Code 連携）                             |

### インタラクティブ版（Scalar / Swagger UI）

| URL                              | 対象                                       |
| -------------------------------- | ------------------------------------------ |
| https://id.0g0.xyz/docs          | id Worker 内部 API（IdP 開発者向け）       |
| https://id.0g0.xyz/docs/external | id Worker 外部連携 API（連携サービス向け） |

### AI / CLI 向け Markdown

| URL                                 | 対象                           |
| ----------------------------------- | ------------------------------ |
| https://id.0g0.xyz/docs/openapi.md  | id 内部 OpenAPI の Markdown 版 |
| https://id.0g0.xyz/docs/external.md | id 外部 OpenAPI の Markdown 版 |

## 運用ドキュメント

| ファイル                                                   | 概要                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| [cloudflare-github-setup.md](./cloudflare-github-setup.md) | Cloudflare ↔ GitHub 連携セットアップ手順 |

## アーキテクチャ

プロジェクト全体のアーキテクチャは [../CLAUDE.md](../CLAUDE.md) を参照。各 Worker の詳細設計は対応する API 仕様書を参照。
