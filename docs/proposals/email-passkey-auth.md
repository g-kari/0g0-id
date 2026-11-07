# メールアドレス＋パスキー認証の導入案

## 現在の到達点

現行の Google、LINE、Twitch、GitHub、X の認証経路とプロバイダー設定は維持する。callbackの最終ポリシー処理を共通関数へ抽出し、bootstrap昇格には検証済みメールを明示的に要求する。追加プロバイダー名は未確定であり、既存要望の GitHub / X / LINE / Twitch を新規要望と取り違えない。

この変更は **認証ストレージ、default-offのメール配送・新規登録・パスキーログインHTTP/UI** を追加する。ログインrouteとoptional設定型、BFFの非表示リンクを追加するが、有効化する環境変数・binding・既存DB・OAuthプロバイダー型は変更しない。検証器のruntime依存に `@simplewebauthn/server` 14.0.3を正規lockfileと共に追加する。メール登録/所有確認も独立したdefault-off routeとして接続したが、schemaの適用と有効化はしていないため、実際のメール登録・パスキーログインはまだ利用できない。

- `packages/shared/src/db/passkey-challenges.ts`: 256 bit challenge、5分期限、用途・ユーザー・ブラウザー・設定された origin / RP ID の束縛と原子的な一回消費。
- `packages/shared/src/db/passkey-credentials.ts`: 検証済み公開鍵の保存、所有者と不変な登録世代の一致、署名カウンターの compare-and-swap。credential ID の upsert や他アカウントへの移管はしない。
- `docs/proposals/passkey-schema.sql`: 7テーブルの案。通常の migration ディレクトリには置かず、デプロイにも適用しない。
- `packages/shared/src/db/passkeys.test.ts`: 実 SQLite による SQL・制約・期限・競合・削除連動の回帰テスト。
- `packages/shared/src/db/email-signup-intents.ts`: signup専用proof、短命authority、配送ledgerと一回claim。tokenは内部配送用メモリーのみで、DBにはhashを保存する。公開応答へ返さない。
- `packages/shared/src/db/passkey-signup.ts`: 短命pending subjectと32byte WebAuthn user handle、検証後のauthority消費・一般user・handle・公開鍵作成を同一batchで完了する内部helper。
- `workers/id/src/utils/webauthn.ts`: SimpleWebAuthnのoptions/verify adapter。UP/UV、exact origin/RP ID、所有者・handle・credential ID・登録時BEを検証し、解析・署名はライブラリーに委譲する。
- `workers/id/src/utils/verification-email.ts`: default-offの Cloudflare Email Sending adapter と確認メールテンプレート。詳細は [配送設計](./email-delivery.md)。本番binding・送信元設定は適用しない。
- `workers/id/src/utils/passkey-flow.ts`: 実検証器とDB helperを結ぶ内部の登録・認証フロー。同じpendingのoptions応答喪失からの再開、検証済み公開鍵の原子登録、認証challengeの一回消費と登録世代/counter CASを扱う。
- `workers/id/src/routes/auth/finalize.ts`: OAuth callbackから共通化した最終ポリシーと既存認可コード発行。lockout、redirect、service/resource制限、state/PKCE/nonceを維持する。呼出し元が信頼できる認証結果と最新userのban等を確認してから使う。
- `workers/id/src/routes/auth/native-passkey.ts`: メール検索を公開しないdiscoverableログイン。独立した暗号cookie、明示POST、Origin/CSRF/総body上限、署名検証と一回claim、現在のuser/continuation制限を通して共有finalizeへ接続する。IdP/BFFでliteral設定がない限り無効。詳細と未検証条件は [nativeログイン設計](./native-passkey-login.md)。

これらの関数は shared の公開 barrel に export しない。署名検証器の代替でもなく、成功を返しただけで登録・ログインを認可するものでもない。

## 完成までの必須事項

1. 送信元はnoreply@id.0g0.xyzで確定し、Workers Paidは本人申告として把握した。default-off公開メール所有確認と必須IP/全体limiter・UTC日次intent上限は接続した。送信設定、承認済み上限の選択、課金枠と稼働検証は残る。配送サービスの認証、domain/DNS/bindingや本番設定を先に作ったことにはしない。
2. Workers対応のSimpleWebAuthn 14.0.3 adapterを追加し、flowおよびdefault-offログインhandlerではoptions・実署名検証・DB更新の一体試験を行った。実認証器、実Workers/D1の公開経路、ブラウザーの試験は残る。CBOR / COSE / attestation / 署名の独自実装はしない。
3. メールintent、pending record、最終authority消費とuser/公開鍵保存の原子helperと検証器接続flowは追加した。公開handlerは、既存ユーザー用challengeとpending用challengeを混同せず、cookie由来のbrowser bindingと内部authorityだけを渡す必要がある。
4. IdP originの認証UIとBFF/標準OAuthの認可コード接続はdefault-offで追加した。公開メール所有確認と登録UI/routeも独立gateで接続した。詳細は[HTTP設計](./email-passkey-http.md)を参照。登録完了やreceiptだけではcodeを発行せず、続く新しい署名付き認証を要求する。メール＋パスキーを外部OAuthプロバイダーとして偽装しない。
5. 因子追加・失効・最終因子の保護・復旧方針を実装し、既存のプロバイダー解除処理との整合性を確認する。
6. 必須の全体チェック、ブラウザーによる WebAuthn 試験、独立セキュリティレビューを完了する。migration と本番有効化は別の導入段階で行う。

## 新規登録

希望するメールアドレスを入力しただけでは、ユーザー作成、email_verified の設定、既存アカウントへの連携、管理者の bootstrap を許可しない。

- メール確認用 token は十分長い乱数で発行し、DB にはハッシュと短い期限を保存する。メール送信は非同期化し、要求側へは存在有無が分からない一定の応答を返す。配送失敗時も内部エラーや宛先を外部応答へ含めない。
- 同じメールPOSTの再送には、事前に暗号化server stateへ予約したUUIDv4を`serverIntentId`として使う。同じIDから新tokenは返さず、既存intent/outbox・期限・配送結果を上書きしない。呼出し元はその短命stateの期限を先に検証し、保存期間後に古いIDを再利用しない。これはメールの自動再送機能ではない。
- メール確認の試行と送信回数を IP・対象単位で制限する。ログには入力メール、確認 token、challenge response、cookie を残さない。入力された宛先の共有先は選択した配送サービスだけとする。
- メール確認 intent は同じブラウザーの Secure / HttpOnly / SameSite cookie と登録目的に束縛する。リンクの scanner / prefetch だけで intent を消費したりログインしたりしない。確認に続く明示操作で処理する。
- 既存 OAuth アカウントに同じメールがあっても、それだけでパスキーを連携しない。既存アカウントでの新しい再認証と因子追加操作を要求する。
- 既存 email 列の照合規則を棚卸しする。大文字小文字、Unicode、プロバイダー固有の alias を勝手に同一視せず、既存レコードの衝突があれば移行を止める。Gmail の dot / plus 変換も行わない。
- メール確認済みの pending subject に登録 challenge を束縛し、WebAuthn 登録検証後にユーザーと credential を同じトランザクションで保存する。中断した段階でログイン可能なユーザーを残さない。確認 intent、登録 challenge、最終作成処理はそれぞれ一回限りにする。

## WebAuthn の検証境界

すべてのセレモニーでサーバー設定由来の `https://id.0g0.xyz` を expected origin、`id.0g0.xyz` を RP ID とする。リクエストの Host / Origin / 任意の redirect_to から RP ID を決めない。アプリ共通の `0g0.xyz` までスコープを広げない。ブラウザー API はこの IdP origin 上で実行する。

本番 HTTPS を必須とする。ローカル開発は HTTPS テスト origin を用意する。ローカル origin を本番検証器の許可リストへ追加しない。

- 登録は `webauthn.create`、認証は `webauthn.get`、expected challenge、origin、RP ID hash を照合する。
- User Presence と User Verification を必須とし、実際の UV flag を検証する。クライアントの requested option だけを信頼しない。
- 未対応 algorithm、壊れた clientData / authenticatorData / COSE key、署名不一致、cross-origin / top-origin の想定外値を拒否する。attestation は原則 `none` とし、端末 fingerprint を収集しない。
- user handle はユーザーの email ではなく不透明で安定した識別子を使い、認証応答の credential ID と所有者も照合する。
- 検証前に資格情報を保存しない。検証成功後に `consumePasskeyChallenge` が行を返した1要求だけが後続処理へ進める。read の成功だけでは進めない。消費後に失敗した場合は新しい challenge からやり直す。
- 非ゼロ署名カウンターの後退を拒否する。ゼロ固定の同期パスキーを扱い、backup eligibility / state は WebAuthn 検証器で整合性を確認する。カウンターを唯一のリプレイ防止策にはしない。

`browserBinding` はサーバーが生成した32 byteの乱数を `__Host-` cookie で受け取り、信頼されたハンドラーから渡す。request body や query parameter の値で置き換えない。並行した新しい操作で cookie が変わったら古いセレモニーは失敗させる。UI は重複クリックを防ぎ、AbortController と世代判定で古い応答が新しい画面を上書きしないようにする。

## ログイン・既存認証との接続

メール入力の存在有無や credential 一覧を外部へ返さない。メール先行ログインの未知アカウントには、実ユーザーの allowCredentials を露出しない同等の拒否フローを用意する。ログイン全体と credential 単位の試行数を制限する。

パスキー検証後も user の ban、lockout、現在の権限、サービス / resource の利用制限、許可された redirect URI を再検証する。既存の callback finalize 処理を共通化して、認可コードの有効期限、PKCE、state、nonce、resource server の登録世代を維持する。BFF cookie や refresh token を新たな別経路で直接発行しない。admin bootstrap は検証済み email のみを対象とする。

メール検証が取り消されたユーザーは、今回の認証記録 helper でも拒否する。credential の不変な登録世代を保存して照合し、削除→同じ ID / counter で再作成した credential へ古い検証結果を適用できないようにする。ゼロカウンターは世代識別には使えない。

今回の persistence helper は factor 管理、ログイン用 token 発行、lockout、WebAuthn 署名検証を実施しない。signup用メールproof発行と既存メール衝突確認は行う。呼び出し側でそれらを省略できる公開経路を作らない。

## 因子の管理・復旧

因子追加は fresh authentication と CSRF 検証を要求する。既存の検証済み email という DB フラグだけでは、新しい credential を追加する権限にならない。credential ID は他ユーザーへ移管しない。

パスキーだけのユーザーから最後のパスキーを消したり、最後の OAuth プロバイダーを外してログイン不能にしたりしない。複数パスキーの追加を案内する。メールだけによる復旧を暗黙に導入せず、本人確認と復旧後のセッション失効を別途設計する。管理者アカウントの復旧では既存の権限を自動昇格させない。

## 導入と検証

DB schema 案を migration へ昇格する前に、pending registration、メール確認 proof、最終因子の保護を含むテーブル設計を再レビューする。schema の適用後に対応コードを反映し、初期状態では設定不足を fail-closed とする。既存 OAuth はそのまま利用できる状態を保つ。

単一接続の SQLite テストは D1 binding や複数接続競合の実証ではない。公開前にローカル D1 でも `RETURNING`、FK cascade、二重完了、既存 schema と組み合わせた migration を確認する。

必須試験:

- 登録・ログインの成功と、署名・challenge・origin・RP ID・type・UP・UV の各不一致。
- 同一 response の再送、期限境界、同時完了、cookie欠落、他ブラウザー、他ユーザー、メール確認 token の再利用。
- OAuth 既存メールとの衝突、未検証メール、ユーザー削除 / ban / lockout、最後の因子、credential ID の衝突。
- 未知のメールの列挙耐性、送信失敗、メール scanner、quota、セキュリティログの非漏洩。
- Chrome / Safari / Firefox、同期パスキー、外部 security key、端末認証非対応、ユーザーキャンセル、中断・戻る・再送・連打。
- 標準 OAuth authorize / BFF / admin / device flow の既存回帰。

## 参考仕様

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

これらの仕様・ライブラリーの最新版と Workers 互換性は、実際の verifier を採用する段階で再確認する。

## 追加した検証器と原子登録の境界

WebAuthnの登録はnone attestation、resident keyとUVをrequired、ES256/RS256だけを生成・検証する。認証ではUP/UV、credential ID、userHandle、登録時のbackup eligibilityを照合する。backup stateは変化可能として固定しない。counterと登録世代の最終CASはDB側で行い、成功前にsessionを発行しない。外部JSONから所有者・公開鍵・counter・登録世代を組み立てない。解析前に各証明フィールドのサイズを制限し、公開route側でも総body上限を設ける。

pendingのuser IDはメールと無関係な予約UUID、WebAuthn user handleは独立した32byte乱数である。登録完了時にuser単位の永続mappingへ同じhandleを保存し、pending削除後も認証・追加因子で同じhandleを使う。

最終登録batchは、最初のNOT NULL guardにauthority・pending・用途・challenge・owner/handle・browser・設定origin/RP ID・期限・既存メール非衝突を集約する。user/handle/keyの作成、intent消費、pending削除の後、最終guardで全結果をassertする。主要処理が0行になってもNULL制約により先行書込みをrollbackする。guard cleanupだけが異常な場合はcommit後に結果不明となり得るが、残ったguardは登録権限として再利用しない。

commit結果不明はreceiptによる読取照合を行う。照合結果だけでログインを許可しない。また照合nullはban・削除・検証取消でも起きるため、「ユーザーが作られなかった」証明にはしない。別の新規userを作る再送へ置き換えない。

ローカルD1では、30既存migrationからnode:sqliteで生成した最終schemaとseedを転記し、7提案tableとの整合、二重claim、原子登録、途中衝突/最終assert失敗のrollback、並行完了、commit応答喪失を確認した。正式migrationをD1へ直接適用した試験でも、remote D1試験でもない。WebAuthnは公開の合成fixtureおよびメモリー内一時鍵で実ライブラリーを検証し、ローカルworkerdでも登録・認証陽性と拒否を確認した。実認証器・実メール・ブラウザー・公開routeのE2Eは未検証である。

接続flowの一体試験は、メールproofからUP/UV付き登録、一般user/handle/公開鍵の原子保存、署名付き認証、replay・並行完了・登録世代の変更・ban/メール検証取消を対象とする。共通finalizeの試験では、native methodでも既存の標準認可コードだけを発行し、サービスredirect、lockout、resource制限と登録世代を再確認する。未検証メールは通常の既存ログインを一律拒否しないが、bootstrap昇格には使わない。このflow試験だけではHTTP公開経路を検証したことにはならない。追加したdefault-off signup HTTP試験と限定native workerd smokeの範囲は[HTTP設計](./email-passkey-http.md)を参照。
