# IdP API リファレンスの自動生成（2026-10-02）

IdP の OpenAPI 仕様から、パラメータ・認証・リクエスト本文・レスポンス・
スキーマをローカルで読める Markdown に生成します。

- [内部 API](./generated/id-internal.md): `INTERNAL_OPENAPI` のみ
- [外部連携 API](./generated/id-external.md): `EXTERNAL_OPENAPI` のみ

## 更新手順

リポジトリルートで、既存の依存を `vp install` した後に実行します。

```bash
vp run docs:api:generate
vp run docs:api:check
```

1. `workers/id/src/routes/openapi/internal-spec.ts` または `external-spec.ts` を更新
2. `vp run docs:api:generate` で両リファレンスを更新
3. `vp run docs:api:check` と通常の `vp check`・`vp test run` を実行
4. 仕様変更と `docs/generated/` の変更を同じコミットに含める

生成ファイルの手編集はしないでください。CI は `--check` だけを実行し、
生成内容との差分・欠落があれば失敗します。ファイルもディレクトリも書き込みません。
日時・乱数・環境変数・実 API レスポンスは生成に使いません。同じ仕様は同じバイト列になります。
実行にはネットワーク・認証情報・DB・Worker の起動が不要です。

出力先は上記2ファイルに固定され、任意の出力パスは受け付けません。
出力ディレクトリ/ファイルのシンボリックリンク、通常ファイル以外、ハードリンクは拒否します。
不足したローカル参照・外部参照・循環参照・不正な仕様はエラーになり、黙って省略しません。
循環スキーマは現状サポート外です。参照は対象仕様内でのみ解決されます。

## 読み方と範囲

テーブルは `enum`・nullable・既定値・数値/長さの範囲・必須項目・ローカル `$ref` を表示します。
`allOf` / `oneOf` / `anyOf` は分岐として展開します。
必須は各オブジェクト内の指定で、省略可能な親の子項目は親が存在するときに適用されます。
認証要件未指定やスキーマ未定義は「仕様に記載なし」と表示します。
生成物は仕様の投影であり、全ルートと実装の自動一致を保証するものではありません。

この変更では、既存の管理者監査ログ一覧と統計の契約を実装に照合して内部仕様へ補います。
一覧の3フィルター・ページング、管理者認証、エラー形式、統計の期間を反映します。
外部仕様の不足した `OAuthError` 参照も既存レスポンスの形式で補います。
API 処理・認証/権限・DB・依存・インフラ・課金は変更しません。

[api-id.md](./api-id.md)・[api-user.md](./api-user.md)・[api-admin.md](./api-admin.md)・
[DBSC](./dbsc.md) は引き続き手書きの設計/運用資料です。上書きしません。
User/Admin BFF の生成・全ルートとの乖離監査・preflight への組込みは今後の範囲です。
Issue [#257](https://github.com/g-kari/0g0-id/issues/257) の IdP 部分であり、Issue は未完了のまま残します。
