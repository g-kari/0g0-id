# 標準トークン・UserInfo・デバイスの実装契約

2026-10-11時点のIdPハンドラーを説明する資料です。仕様は内部/外部の両OpenAPIと
[生成リファレンス](./api-reference-generation.md)へ反映します。
規格への完全適合や本番クライアントとの接続成功を保証する資料ではありません。

## POST /api/token

本文は application/x-www-form-urlencoded のみです。JSONは400 invalid_request。
未指定/未知のgrant_typeは400 unsupported_grant_typeです。
本文client_secretは認証に使いません。

| grant_type                                   | 入力                                                           | クライアント確認                                                      |
| -------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| authorization_code                           | code、redirect_uri。公開clientはclient_idとPKCE verifierも必須 | secret_hashがあるclientはBasic。secretなしは本文client_id             |
| refresh_token                                | refresh_token。公開clientはclient_idも必須                     | 認可コードと同じBasic/公開clientの分岐                                |
| urn:ietf:params:oauth:grant-type:device_code | device_code、client_id                                         | 本文client_idと保存コードのサービス一致。Basic/secretは認証に使わない |

Basicで認証するとき本文client*idは省略できますが、指定時は同じclientでなければ401。
公開clientの認可コード交換ではS256 PKCEが必須です。confidential clientでも保存済み
challengeがあればverifierが必要です。verifierは43〜128文字の英数・-.*~です。
redirect_uriは正規化後に比較し、loopback localhost/127.0.0.1とポートに既存の特例があります。
コードはredirect/PKCEなどの後続検査より先に消費されるため、同じcodeの再送が成功するとは限りません。

成功はflatなaccess_token、token_type=Bearer、expires_in=900、refresh_tokenです。
refresh tokenの期限は30日で、offline_accessを要求しなくても発行します。
有効scopeが空でなければscopeを含みます。認可コード/デバイス交換ではopenidがあると
id_tokenを含みます。refreshではid_tokenを返しません。
認可コード/デバイスは保存scopeを現在の許可scopeと照合し、refreshは保存scopeを再利用します。
legacy未保存scopeだけ現在の許可scope/openidへfallbackします。交換本文scopeは使いません。

デバイス未承認は400 authorization_pending、早すぎるポーリングは400 slow_downと
Retry-After: 10です。期限切れは400 expired_token、拒否は400 access_denied。
refreshのローテーション競合は400 invalid_grantで、BFFの/auth/refreshにある503とは別です。
認可コード/refreshの認証失敗は401 invalid_clientとBasic challengeですが、device grantの
401にchallengeは付きません。停止ユーザーはrefresh/deviceでは403 access_denied、
認可コード交換では400 invalid_grantです。

## POST /api/device/code と /api/device/verify

/codeはformまたはJSONの本文client_idで登録済みサービスを識別します。
Basic/Bearer/client_secretは要求しません。未知clientは401 invalid_client。
scope省略/空はopenid、明示scopeは現在の許可値へ絞ります。openidは常に許可されますが、
明示した別scopeへ自動追加されません。絞った結果が空なら400 invalid_scopeです。

200はflatなdevice_code（64文字）、user_code（XXXX-XXXX）、verification_uri、
verification_uri_complete、expires_in=600、interval=5の6項目です。
verification_uriはUSER_ORIGIN + /device、completeは?code=<表示user_code>を付けます。
ポーリング先は/api/tokenです。/api/device/tokenというルートはありません。

/verifyはBearer署名・issuer/audience・失効を検査し、cid付きservice tokenを403で拒否します。
ユーザー不存在/停止は401です。BFFのX-BFF-Session-Idを指定した場合は有効sessionも確認します。
追加の管理者/サービス所有者限定やOrigin/CSRFチェックはこのIdPルートにありません。
有効なuser_codeを保持する認証済みユーザーのsubで承認します。

本文はJSONとして読みます（Content-Typeを明示検査するルートではありません）。
user_codeは空白/ハイフンを除去し大文字へ正規化した後、ABCDEFGHJKMNPQRSTUVWXYZ23456789の
8文字を要求します。action省略/空は情報取得のみ、approve/denyは状態変更です。
200の情報取得はdata:{service_name,scopes}、承認/拒否はstatus:approved/deniedです。
400 BAD_REQUEST/CODE_EXPIRED/CODE_ALREADY_USED、404 INVALID_CODEはREST形式です。
既存のcatchには500 {error:"INTERNAL_ERROR"}というflat応答もあります。

## GET/POST /api/userinfo と現状の制約

同じハンドラーで、Authorization: Bearerヘッダーのみを使います。
POST本文は読み取らず、本文access_tokenでは認証しません。
共通認証はES256署名、iss=IDP_ORIGIN、aud=IDP_ORIGIN、期限と失効を検証します。
一方、issueTokenPairのservice access tokenはaud=client_idです。
したがって通常のservice tokenをそのままUserInfoへ渡せるとは保証できません。
この既存のaudience制約を文書化し、認証ポリシーは変更しません。

認証を通ったtokenにcidがあればpairwise sub、cidがなければ内部ユーザーIDです。
常時subとupdated_at（Unix秒）、scopeに応じて次のflatクレームを返します。

| scope     | クレーム                                            |
| --------- | --------------------------------------------------- |
| 未指定/空 | name、picture、email、email_verifiedのみ            |
| profile   | name、picture（null可）                             |
| email     | email、email_verified（boolean）                    |
| phone     | 保存値が非nullならphone_number。なければ省略        |
| address   | 保存値が非nullならaddress:{formatted}。なければ省略 |

openid scopeそのものはこのハンドラーの必須条件ではありません。
data包み、role、provider IDsは返しません。
認証middlewareの401はREST形式、ユーザー不存在/停止の401はOAuth invalid_tokenです。
ユーザー取得DB例外の500はOAuth server_errorで、共通例外はREST形式もあります。

## 共通エラーと検証範囲

OAuth形式は{error:string,error_description?:string}で、説明を省略する応答もあります。
REST形式は{error:{code,message}}です。両形式があり、一律のschemaとして扱いません。
IdPの共通body上限64KiBは413 PAYLOAD_TOO_LARGE。
共通レート制限は429 TOO_MANY_REQUESTS、Retry-After: 60です。
本番の必須limiter binding未設定は503 SERVICE_UNAVAILABLE。
deviceのslow_down（400/Retry-After:10）と区別してください。

今回のリリースは4操作の仕様追加、既存UserInfo GET説明の訂正、手書き/生成資料と
合成回帰の同期のみです。実行時ハンドラー、認証/権限、データ、依存、CI設定は変更しません。
合成データ・一時鍵・fake D1/limiterで確認するため、実アカウント/本番D1/実クライアント
接続の証明にはなりません。残るユーザー管理、metrics、DBSC等の未記載操作とその他契約は
Issue #257の継続範囲です。この限定変更でIssue全体を閉じません。
