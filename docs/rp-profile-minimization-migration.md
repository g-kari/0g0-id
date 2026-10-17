# RP向けプロフィール最小化の互換性・移行メモ

[PR #303](https://github.com/g-kari/0g0-id/pull/303)の限定変更に伴う、外部アプリ側の確認事項です。
この資料は既存データの移行・削除・失効や本番配備を実行するものではありません。

## 変更対象と維持する契約

- 新規RP access tokenはemail/IdP roleを含めません。ID tokenもemail/name/picture等を含めません。
- 標準authorization_code/device_code/refreshと旧exchange/refreshが対象です。
- RP UserInfo GET/POST、External API一覧/詳細はpairwise subのみです。
  Introspectionもプロフィールを追加しません。External APIのname/email検索は403になります。
- 旧exchangeのdata.user.idは従来からpairwiseですが、旧refreshのdata.user.idは
  内部UUIDから同じサービス固有pairwise値へ変わります。旧refreshのIDを永続キーとして
  保存していたアプリは、プロフィール項目だけでなく、この識別子変更も確認してください。
- pairwise計算方法/salt/既存pairwise値は変更しません。新規RP access tokenのsubには
  依然内部UUIDが残ります。access tokenのsubをpairwise識別子と扱わないでください。
- IdP内部/BFFのaccess tokenとJSON userプロフィール契約は維持します。
  BFFはID tokenを消費せず、既存JSON userでセッションを構築します。
- issuer/audience/ES256検証、認可コード/PKCE、refresh rotationと失効境界は維持します。
  既存UserInfo/introspection/MCPのaudience不一致を緩める変更ではありません。

## アプリ側で影響を検出する

まずアプリのソースと合成fixtureで、次の依存を探してください。実ユーザーのJWT、
メールアドレスやプロフィールを調査用ログへ出す必要はありません。

1. ID token/access token/Introspection/UserInfo/External APIのemail、name、picture、
   role等を必須としているschema、非null前提の処理、画面表示や認証判定。
2. 旧refreshのdata.user.idを使ったaccount lookup/upsert。旧exchangeのpairwise IDや
   ID tokenのsubと同一だと仮定している箇所も、両応答を合成値で比較します。
3. メールアドレスでのアカウント自動結合や、RP tokenのIdP roleでの管理者判定。
   欠落したroleへadminを補うfallbackは使いません。
4. External APIのname/email検索。空文字のqueryも拒否対象です。
5. shared TokenPayloadのemail/roleを必須としていたTypeScript consumer。
   一般decode型では省略可能、新規RP出力型では禁止、BFF出力型では必須として分離します。
   既発行tokenのdecodeでは旧プロフィールが残る場合があるため、値の存在を確認します。

合成テストは同じclientのpairwise値が再認証・refreshで安定し、異なるclientでは違うこと、
プロフィール欠落でログイン処理が壊れないこと、BFFの既存プロフィールが保たれることを確認します。
同repoのCI成功だけでは、別アプリのDBキーや実運用の互換性を保証できません。

## 再認証と既存アカウントの対応付け

1. アプリの必須profile依存を先に除き、移行前の設定・対応表を復元可能に保存する計画を立てます。
   既存レコードやtokenを無確認で削除・一括失効しません。
2. アプリの通常の認証開始経路から再認証します。state/PKCEを保持し、ID tokenを使う場合は
   JWKSによるES256署名、issuer、当該client audience、期限とnonceを検証します。
   email/name等の有無を本人性の証明の代わりにしません。
3. 新しいアプリ内識別子はissuerとclientの文脈を含むpairwise subjectとして扱います。
   旧JSON経路では、そのclientへ返ったdata.user.idがpairwise値です。
   内部UUIDのaccess-token subや他のclientのsubjectを、この値の代わりに使いません。
4. 既存アプリの認証済みセッションと検証済み新subjectが同じ利用者のものであることを、
   アプリ側の正規のアカウント連携/復旧手順で確認してから対応付けます。
   メールアドレス一致だけで自動結合せず、確認できないレコードは個別復旧へ回します。
5. アプリ管理者が合成試験、段階的切替、復元手順を確認してから実運用への適用を判断します。
   本PRは外部アプリの対応表更新や本番DB migrationを実行しません。

## 既存制約と範囲外

一般RP tokenのaudはclient_idですが、現UserInfo/introspection/MCPの認証はIDP_ORIGINを
要求する既存制約があります。MCPにはさらにpayload.kid必須とJWSヘッダーkidの不一致が残ります。
MCPの型は既存Zod検証から導出しますが、schema/audience/認証動作は変更しません。
CIのMCP smokeは手製のkid付きJWTを使い、IdP実発行JWT→MCPの成功を証明しません。

必要保持項目の暗号化、provider/DB収集、MCP応答、BFF、ログ/分析/backupの最小化、
本人の項目・送信先・目的consentと既発行token/clientコピーの消去は別途の未完了項目です。
pairwiseは仮名識別子で匿名化ではなく、JWT署名も暗号化ではありません。
