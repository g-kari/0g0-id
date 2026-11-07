# Error log privacy

## 2026-10-15: 未処理例外のログ最小化

IdP / user BFF / admin BFF / MCP Worker の global `onError` は、例外オブジェクトを
logger へ渡さず、`level: error`、Worker の固定 `ctx`、`msg: Unhandled error` だけを
記録します。例外の message / stack / cause / 任意プロパティは参照しません。
例外に含まれ得る個人情報・token の console 出力を抑える局所的な変更です。

HTTP 応答は従来どおり 500 と
`{ "error": { "code": "INTERNAL_ERROR", "message": "Internal server error" } }` です。
認証・認可判断、成功応答、ルート、Cookie、UUID、DB schema、設定は変更しません。

運用上、global handler から例外種別・詳細メッセージ・stack trace は得られなくなります。
Worker context と固定イベントは残りますが、個別障害の診断粒度は意図的に下がります。
合成例外を注入する Worker 統合テストで、実 logger の console 出力と固定 500 を検証します。

## 2026-10-15: 監査書き込み失敗の console ログ最小化

IdP の `logAdminAudit` は監査書き込みに失敗した場合、例外や入力フィールドを logger に渡さず、
固定の `level: error`、`ctx: audit`、`msg: Failed to create admin audit log` だけを記録します。
例外の任意プロパティや `toJSON`、対象 ID、action / targetType / status を参照し直しません。
このため、例外のシリアライズ失敗で監査失敗が呼び出し元へ伝播する経路も除かれます。

監査書き込みに成功する場合の SQL、保存する全フィールド、details JSON、IP は変更しません。
操作自体の成功・失敗応答、認証・認可・CSRF 判断、操作順も維持します。
一方、監査書き込み失敗の console ログから操作種別・対象・例外詳細を調べることはできなくなり、
診断粒度は意図的に下がります。実 helper / SQL builder / logger と fake D1 を使う合成テストで、
固定ログと監査失敗の非伝播、既存の操作応答・成功時保存値を検証します。

## これらの変更が保証しないこと

上の局所変更だけでは、共有 `createLogger` 自体や他の呼び出し元は変更していませんでした。
以下の共有 logger 境界を追加した後も、全ログの個人情報非保持やシステム全体の匿名化を
保証しません。対象外・残る制限は末尾を参照してください。

## 2026-10-15: 共有 logger の metadata 境界（リリースノート）

`createLogger` は全 level（debug / info / warn / error）で、従来の任意の第2引数を
出力しなくなります。Error の message / stack / cause / name、文字列、オブジェクト、
配列、循環参照、関数、Proxy、`toJSON` も含めて、引数のプロパティ・prototype を
検査せず、列挙・型変換・`instanceof`・シリアライズをしません。既存の呼び出し元を
一括変更する代わりに、第2引数は型上 `unknown` のまま受け付け、認識できない値を無視します。

許可する metadata は、logger モジュール内の非公開 WeakMap に登録された opaque token
だけです。token の外観、コピー、継承、Proxy wrapper、任意プロパティからは認定しません。
record は新しく作る null-prototype object へ検証済み primitive だけを格納し、凍結します。
token に格納値を公開しないため、呼び出し後の書き換えで任意の値を混入させることもできません。
ログ entry 自体も null-prototype とし、継承された `toJSON` を呼び出しません。

維持する metadata は次の3種類だけです。

- `httpStatusMetadata(status)`: primitive number の整数 100–599 のみ。provider token
  exchange の6箇所と BFF DBSC の4箇所で、既存の固定イベントと status を維持します。
- `deletedCountMetadata(deletedCount)`: primitive number の非負 safe integer のみ。
  IdP scheduled cleanup の3箇所で、既存の aggregate deletedCount を維持します。
- HTTP request middleware 専用の内部 positional helper: 既存の標準method分類、登録route
  pattern / `[unmatched]` / `[error]`、status、elapsed_ms を維持します。elapsed_ms は
  primitive number の非負 safe integer のみです。内部 helper は shared の公開 barrel に
  export せず、汎用の任意文字列・任意オブジェクト用 builder は提供しません。

文字列化した数値、boxed number、NaN、Infinity、範囲外・小数などは変換せず拒否します。
helper のどれかの引数が不正な場合は token を発行せず、固定イベントだけを出力します。
HTTP helper の route 書式検査は request middleware の既存 sanitizer に対する追加の検査です。
登録routeがコード定義であるという前提は維持され、runtime の文字列検査だけで route の
出所を証明するものではありません。内部 helper を他の呼び出し元へ転用しないでください。

`level` / `ctx` / `msg` と console の振り分けは維持します。error は console.error、warn は
console.warn、debug / info は console.log に出力します。HTTP 応答、認証・認可・CSRF・DBSC
判断、cleanup の実行順と SQL、DB schema、設定は変更しません。

運用上、移行していない全 extra は意図的に消えます。例外詳細だけでなく、user / session /
service 等の ID、failedAttempts、reason、raw request path、環境変数検証の errors、
upstream deprecation の header / method / path も console metadata から得られなくなります。
固定イベントは残りますが、診断粒度と既存の data field に依存した検索・集計は変わります。
必要な診断項目の追加は、個別に primitive・用途・出所をレビューしてから行ってください。

検証は、実 logger の全 level、getter / toJSON / coercion hook / 循環参照 / revoked Proxy /
偽造token、正当・不正な primitive helper 入力を含みます。既存の44件の HTTP middleware
privacy/応答テストと54件の provider 応答・retry テストを維持し、BFF の全4 status site と
scheduled cleanup の全3 count site について実 logger の統合テストを追加しています。

## 共有 logger 境界の残る対象外・制限

- `ctx` / `msg` は引き続き呼び出し元の文字列です。動的 msg に埋め込まれた token ID
  （refresh-tokens / token-recovery）や service ID（introspect / services CRUD）等は残り、
  この変更で全ログの識別子非保持を保証しません。固定イベントへの移行は別の作業です。
- logger に渡す前の引数評価は止められません。service-binding の `instanceof` / `String(err)`、
  DBSC の reason 作成時の `err.message` 参照などは呼び出し元で従来どおり実行されます。
  それらの extra の出力は抑止しますが、呼び出し元の getter / coercion の副作用や例外を
  除去する変更ではありません。
- 生の console 呼び出し、Hono / runtime の独自ログ、DB の audit / login log、Cloudflare
  invocation metadata は共有 logger の境界外です。既存ログ・DB 行、IP・識別子、分析・
  backup の保持と暗号化、削除・保持期限、鍵、本番設定も変更しません。
- console sink 自体の失敗や、logger module / JavaScript built-in の書き換えに対する
  sandbox を提供しません。未知 extra のシリアライズ失敗は避けますが、console が投げる
  例外まで握り潰す保証ではありません。
- source-compatible な第2引数を残すため、型検査だけでは誤った extra を検出できません。
  新しい呼び出し元は固定 ctx / msg と上記の承認済み helper だけを使用してください。
