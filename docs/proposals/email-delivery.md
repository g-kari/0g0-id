# メール所有確認の配送設計

確認日: 2026-11-07。これは本番設定を変更しない導入案である。

## 方式

既存の Cloudflare Workers に **Email Sending の native binding** を追加する方式を第一候補とする。新規 API キーや SMTP password は不要で、MIME ライブラリーも追加しない。公式の構造化 API と既存 `@cloudflare/workers-types` の `SendEmail` 型を使う。

任意ユーザーへの送信は Workers Paid と送信ドメインの onboarding が必要。Workers Paid は最低 $5 USD/月、Email Sending は月3,000通/account込み、超過は $0.35 USD/1,000通。既に Workers Paid なら基礎料金を重複加算する意味ではない。契約状態・日次枠・最新料金を有効化時に確認する。

Email Routing だけの無料送信は、アカウント内の事前検証済み宛先に限定される。一般ユーザーの新規アカウント確認メールの代用にはしない。Email Sending は公開 beta のため、一般提供サービスと同じ SLA を前提にしない。

公式資料:

- [Email Sending 料金](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Workers 料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [送信ドメイン設定](https://developers.cloudflare.com/email-service/configuration/domains/)
- [送信 binding の制限](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
- [制限](https://developers.cloudflare.com/email-service/platform/limits/)
- [ローカル送信](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

代替の Resend も Workers から利用できるが、別途ドメイン認証と永続 API キーが必要となる。新しい認証情報を増やさない native binding を優先する。[Resend 公式料金](https://resend.com/pricing)

## 今回の実装

`workers/id/src/utils/verification-email.ts` を追加する。既存の Env、Wrangler、公開 route は変更しない。呼び出し元はまだなく、binding と送信元が設定済みであることや、本番送信が可能であることを意味しない。

- `buildVerificationEmail`: 固定件名の日本語 text / HTML。1通1宛先。任意の本文、header、CC/BCC、添付、外部リンクを受け付けない。
- 宛先と送信元は単一の ASCII mailbox のみ受け付ける。表示名形式、アドレス一覧、CRLF、引用 local part、国際化メールアドレスは現段階では非対応として拒否する。
- 確認 URL はサーバー設定由来の HTTPS origin と固定 path `/auth/email/verify` だけを使う。32 byte乱数の token を fragment に入れ、HTTP access log や Referer への混入を避ける。token は access/session token とは別の一回限りのメール確認 proof とする。
- `expiresAt` は intent の有効期限と同じ Unix 秒を渡す。期限切れ・15分超・非整数を送らない。adapter 自体は token の生成、DB保存、ハッシュ化、消費を行わない。
- `sendVerificationEmail` は明示的な enable、binding、固定送信元が揃わなければ送信しない。1回だけ `send()` を呼び、10秒で結果不明を返す。timeout は送信の取消ではない。
- `accepted` は provider の受付であり、受信箱への配送やメール所有確認の完了ではない。標準 Error の既知拒否 code だけを分類し、生の error.message、宛先、token、本文をログや戻り値へ流さない。未知の例外・SMTP失敗・不正な戻り値・timeout は結果不明として扱い、自動再送しない。
- 呼び出し結果は内部処理用。外部 route はアカウントの存在や送信成否が分からない一般的な応答にし、backend の rate limit と送信 intent / outbox を別途実装する。

## 公開接続前の条件

1. 送信元アドレスと sender domain を確定する。専用サブドメインを使う場合も、既存の受信 MX を壊さない計画を確認する。
2. Workers Paid の既存契約と送信日次枠を確認し、新規契約・追加費用が必要なら先に承認を得る。
3. Cloudflare Email Sending に送信ドメインを onboarding し、bounce 用 MX / SPF、DKIM、DMARC を設定する。DNS変更と有効化はコード追加とは別の操作として扱う。
4. 確定した送信元だけを `allowed_sender_addresses` で許可する `send_email` binding を追加する。新しい binding には現在の Wrangler で型生成と設定検証を行う。APIキーを作って代替しない。
5. メール確認 intent、永続送信状態、濫用防止と token 消費を実装する。確認ページでは CSP / Referrer-Policy を設定し、fragment を最初に読み取って history から除き、third-party asset / tracking を載せない。GET / scanner / prefetch だけでは proof を消費せず、明示操作で同一ブラウザーに束縛した POST を行う。
6. 確認ページ・intent・登録処理が完成するまでこの adapter を enable しない。現在の固定 path はまだ公開実装されていないため、その段階の実メール送信は利用者を壊れたリンクへ導く。
7. ローカル模擬送信で payload と結果分類を確認する。`remote: true` は実配送になるため、自動テストへ入れない。実配送試験は送信先・送信元・用途を確定した1通から始め、受付、配送、proof消費を分けて確認する。

token 発行／検証、登録完了、復旧、outbox の永続化はこの adapter では未実装である。結果不明の再送では新しい token を次々発行せず、provider の受付状態と intent の状態を照合する設計を先に用意する。
