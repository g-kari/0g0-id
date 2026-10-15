# Global error log privacy

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

## この変更が保証しないこと

共有 `createLogger` 自体や他の呼び出し元は変更していません。他の console / audit / login
log、Cloudflare invocation metadata、既存ログや DB 行、IP・識別子、分析・backup の
保持と暗号化は別途の対象です。既存データの削除、保持期限の変更、鍵や本番設定の変更も
行いません。この変更だけで、全ログの個人情報非保持やシステム全体の匿名化を保証しません。
