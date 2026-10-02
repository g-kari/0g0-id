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
User/Admin BFF のエンドポイント一覧は下記の双方向チェックで監査します。
BFF の本文/レスポンス・認証説明の自動生成、IdP の全実装ルート監査、
DBSC 設計文書の意味的な照合、deploy preflight への組込みは今後の範囲です。
Issue [#257](https://github.com/g-kari/0g0-id/issues/257) は未完了のまま残します。

## BFF の手書き API 一覧の同期確認

`vp run docs:api:check` は IdP の生成物チェックに続き、
`docs/api-user.md` / `docs/api-admin.md` の Method/Path テーブルを検査します。
`workers/user/src/index.ts` / `workers/admin/src/index.ts` を読み込み、
Hono の実際の登録済み `routes` と双方向照合するため、サブルーターや共通認証ファクトリの
エンドポイント、`/auth/dbsc/start`・`/auth/dbsc/refresh`、ヘルスチェック、
API 404/MPA フォールバックも対象です。現時点で user 33件・admin 51件です。
ハンドラーは呼び出さず、Worker 起動・ネットワーク・環境変数・認証情報・DBを使いません。

- 新しい method/path の登録: 対応するテーブル行がなければ失敗
- endpoint の削除・method/path の変更: 古い行が残っていても失敗
- 不正な行、重複、空の一覧、文書の欠落: 明示的に失敗
- 同一 route の複数ハンドラーは1件。`*` と Hono の `/*` は同じフォールバックとして扱う
- 応答コード表・転送先・説明文・コードフェンス内の例は endpoint として数えない
- 検査は読み取り専用。手書き文書を自動生成した内容で上書きしない

新規/変更ルートと同じコミットで該当テーブルの最初の2列を `Method` / `Path` 形式で更新し、
パスは単一の inline code にします。複数テーブルへの分割は維持できます。
生成済み IdP 資料の更新コマンドは BFF テーブルを修復しないため、BFF は手で更新してください。
現時点の差分監査では admin のロックアウト確認/解除、DBSC バインド集計、
IP/UA 統計・ログインイベント一覧の計6行の記載漏れを補いました。

検査対象は method-specific な登録です。`ALL` は Hono の middleware と区別できないため除外します。
新しい endpoint は既存の `get` / `post` / `patch` / `delete` 等を使い、
`all()` での endpoint 追加が必要な場合はこの検査も拡張してください。
一覧の一致は入力・レスポンス schema や middleware の安全性の一致を保証しません。
これらと [DBSC 設計文書](./dbsc.md) の説明は引き続きコードレビュー対象です。

### リリース・ロールバック

1. `vp run docs:api:check`、`vp check`、`vp test run` と frontend build を確認
2. draft PR の最終 head に対する必須 CI と audit が成功した後、ready に変更してマージ
3. master の同じコミットで docs check と CI が成功したことを確認

実行時コード・API・認証設定・依存・DB schema に変更はなく、Worker のデプロイや
シークレット設定・マイグレーションは不要です。導入後は既存 CI の docs step から自動実行されます。
必要なら PR を revert すると、従来の IdP 生成物チェックだけに戻ります。
