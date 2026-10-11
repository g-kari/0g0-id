// Documentation data only. These describe the existing handlers, not an auth-policy change.
const oauthError = {
  type: "object",
  properties: {
    error: { type: "string", description: "OAuthエラーコード。説明を省略する応答もある。" },
    error_description: { type: "string" },
  },
  required: ["error"],
};
const restError = { $ref: "#/components/schemas/Error" };
const mixedError = { anyOf: [oauthError, restError] };
const transportErrors = {
  "413": {
    description: "共通body制限（64KiB）: PAYLOAD_TOO_LARGE。REST形式。",
    content: { "application/json": { schema: restError } },
  },
  "429": {
    description: "共通レート制限: TOO_MANY_REQUESTS。デバイスのslow_down（400）とは別。",
    headers: { "Retry-After": { schema: { type: "string", enum: ["60"] } } },
    content: { "application/json": { schema: restError } },
  },
  "503": {
    description: "本番レート制限binding未設定: SERVICE_UNAVAILABLE。REST形式。",
    content: { "application/json": { schema: restError } },
  },
};
const tokenResponse = {
  type: "object",
  properties: {
    access_token: { type: "string" },
    token_type: { type: "string", enum: ["Bearer"] },
    expires_in: { type: "integer", enum: [900] },
    refresh_token: { type: "string", description: "30日。有効な交換でローテーションする。" },
    scope: { type: "string", description: "有効スコープが空でない場合に含む。" },
    id_token: {
      type: "string",
      description:
        "authorization_code/device_codeでopenidスコープがある場合のみ。refreshでは返さない。",
    },
  },
  required: ["access_token", "token_type", "expires_in", "refresh_token"],
};
const clientId = {
  type: "string",
  description:
    "登録済みclient_id。公開クライアントとdevice_codeは必須。Basic認証時は省略可だが指定値は認証したclientと一致必須。",
};

export const STANDARD_TOKEN_OPERATION = {
  tags: ["認証フロー"],
  summary: "標準OAuthトークン交換・更新・デバイスのポーリング",
  description:
    "既存POST /api/token。application/x-www-form-urlencodedのみ。JSONは受け付けない。\n\n" +
    "authorization_code/refresh_token: client_secret_hashのあるサービスはclient_secret_basicで認証する。" +
    "secretのない公開クライアントは本文client_idで識別する。本文client_secretは認証に使わない。\n" +
    "device_code: 本文client_idと保存済みコードのサービス一致を確認し、Basic/client_secretは認証に使わない。\n\n" +
    "公開クライアントのauthorization_codeはPKCE必須。保存コードにchallengeがあるconfidential clientにもverifierが必要。" +
    "redirect_uriは正規化後に照合する（localhost/127.0.0.1とloopbackポートの比較に特例あり）。\n" +
    "authorization_code/device_codeは保存済みスコープを現在の許可スコープと照合する。" +
    "refreshは保存済みスコープをそのまま再利用し、legacy未保存時だけ現在の許可スコープ/openidへfallbackする。本文scopeは使わない。\n" +
    "deviceの未承認はauthorization_pending、早すぎるポーリングはslow_down（400/Retry-After:10）。" +
    "refreshのローテーション競合もinvalid_grant（400）であり、BFF /auth/refreshの503ではない。\n" +
    "発行service tokenのaudienceはclient_id。現在のUserInfo認証はIDP_ORIGINをaudienceに要求するため、互換性は別途確認が必要。",
  security: [{ BasicAuth: [] }, {}],
  requestBody: {
    required: true,
    content: {
      "application/x-www-form-urlencoded": {
        schema: {
          oneOf: [
            {
              type: "object",
              properties: {
                grant_type: { type: "string", enum: ["authorization_code"] },
                code: { type: "string", description: "未使用・未期限切れの認可コード。" },
                redirect_uri: { type: "string", format: "uri" },
                client_id: clientId,
                code_verifier: {
                  type: "string",
                  minLength: 43,
                  maxLength: 128,
                  pattern: "^[A-Za-z0-9._~-]+$",
                  description:
                    "公開クライアント、または保存コードにPKCE challengeがある場合は必須（S256）。",
                },
              },
              required: ["grant_type", "code", "redirect_uri"],
            },
            {
              type: "object",
              properties: {
                grant_type: { type: "string", enum: ["refresh_token"] },
                refresh_token: { type: "string" },
                client_id: clientId,
              },
              required: ["grant_type", "refresh_token"],
            },
            {
              type: "object",
              properties: {
                grant_type: {
                  type: "string",
                  enum: ["urn:ietf:params:oauth:grant-type:device_code"],
                },
                device_code: { type: "string" },
                client_id: {
                  type: "string",
                  description: "コードを発行したサービスのclient_id。Basicでは代用しない。",
                },
              },
              required: ["grant_type", "device_code", "client_id"],
            },
          ],
        },
      },
    },
  },
  responses: {
    "200": {
      description: "data包みなしのトークン応答。refreshにid_tokenは含まない。",
      content: { "application/json": { schema: tokenResponse } },
    },
    "400": {
      description:
        "invalid_request/unsupported_grant_type/invalid_grant/invalid_scope/expired_token/access_denied/authorization_pending/slow_down。error_descriptionは省略可。",
      headers: {
        "Retry-After": {
          description: "device slow_downのときのみ10秒。",
          schema: { type: "string", enum: ["10"] },
        },
      },
      content: { "application/json": { schema: oauthError } },
    },
    "401": {
      description:
        "invalid_client。authorization_code/refreshの認証失敗にはBasic challenge。device_codeには付けない。",
      headers: { "WWW-Authenticate": { schema: { type: "string" } } },
      content: { "application/json": { schema: oauthError } },
    },
    "403": {
      description: "refresh/deviceで停止済みユーザー: access_denied。",
      content: { "application/json": { schema: oauthError } },
    },
    "500": {
      description: "OAuth server_error、または共通REST MISCONFIGURATION/INTERNAL_ERROR。",
      content: { "application/json": { schema: mixedError } },
    },
    ...transportErrors,
  },
};

const deviceRequest = {
  type: "object",
  properties: {
    client_id: {
      type: "string",
      description: "登録済みサービスを本文で識別。Basic/client_secretでは認証しない。",
    },
    scope: {
      type: "string",
      description:
        "省略/空はopenid。明示したscopeは許可された値へ絞り、openidは常に許可。残りが空ならinvalid_scope。",
    },
  },
  required: ["client_id"],
};
export const DEVICE_CODE_OPERATION = {
  tags: ["認証フロー"],
  summary: "デバイス認可の開始",
  description:
    "本文client_idで登録済みサービスの存在を確認する。Basic/Bearer/client_secretは要求しない。発行コードだけでは認可は成立せず、別のユーザー承認が必要。取得後はPOST /api/tokenの完全なdevice grant文字列でポーリングする。IPレート制限を適用する。",
  security: [],
  requestBody: {
    required: true,
    content: {
      "application/x-www-form-urlencoded": { schema: deviceRequest },
      "application/json": { schema: deviceRequest },
    },
  },
  responses: {
    "200": {
      description: "デバイス認可コード（10分）とポーリング間隔（5秒）。data包みなし。",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              device_code: { type: "string", minLength: 64, maxLength: 64 },
              user_code: {
                type: "string",
                pattern:
                  "^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$",
              },
              verification_uri: {
                type: "string",
                format: "uri",
                description: "USER_ORIGIN + /device。",
              },
              verification_uri_complete: {
                type: "string",
                format: "uri",
                description: "verification_uri + ?code=<表示user_code>。",
              },
              expires_in: { type: "integer", enum: [600] },
              interval: { type: "integer", enum: [5] },
            },
            required: [
              "device_code",
              "user_code",
              "verification_uri",
              "verification_uri_complete",
              "expires_in",
              "interval",
            ],
          },
        },
      },
    },
    "400": {
      description: "invalid_request（形式/Content-Type/本文）、invalid_scope。",
      content: { "application/json": { schema: oauthError } },
    },
    "401": {
      description: "invalid_client（client_id未登録）。",
      content: { "application/json": { schema: oauthError } },
    },
    "500": {
      description: "OAuth server_error、または共通RESTエラー。",
      content: { "application/json": { schema: mixedError } },
    },
    ...transportErrors,
  },
};

export const DEVICE_VERIFY_OPERATION = {
  tags: ["認証フロー"],
  summary: "ユーザーによるデバイス認可の確認・承認・拒否",
  description:
    "Bearer認証後、cid付きservice tokenと停止済み/不存在ユーザーを拒否する。BFFトークンは現在のiss/aud=IDP_ORIGIN検証と失効チェックを満たす必要がある。" +
    "管理者/サービス所有者に限定する追加チェックはない。codeを保持する認証済みユーザーのsubで承認する。\n" +
    "JSON本文を読む（Content-Typeの明示検査はない）。user_codeは空白/ハイフン除去・大文字化後、所定文字集合8文字を要求。" +
    "actionを省略または空にすると情報取得のみ。approve/denyを指定すると認可状態を変更する。Origin/CSRFやInternalSecretがこのIdPルートに付くとは主張しない。",
  security: [{ BearerAuth: [] }],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            user_code: { type: "string", description: "例のXXXX-XXXX形式。正規化後8文字。" },
            action: {
              type: "string",
              enum: ["approve", "deny", ""],
              description: "省略/空は情報だけ。",
            },
          },
          required: ["user_code"],
        },
      },
    },
  },
  responses: {
    "200": {
      description: "情報取得、承認、拒否のいずれか。",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              {
                type: "object",
                properties: {
                  data: {
                    type: "object",
                    properties: {
                      service_name: { type: "string" },
                      scopes: { type: "array", items: { type: "string" } },
                    },
                    required: ["service_name", "scopes"],
                  },
                },
                required: ["data"],
              },
              {
                type: "object",
                properties: { status: { type: "string", enum: ["approved"] } },
                required: ["status"],
              },
              {
                type: "object",
                properties: { status: { type: "string", enum: ["denied"] } },
                required: ["status"],
              },
            ],
          },
        },
      },
    },
    "400": {
      description: "BAD_REQUEST/CODE_EXPIRED/CODE_ALREADY_USED。REST形式。",
      content: { "application/json": { schema: restError } },
    },
    "401": {
      description: "UNAUTHORIZED（Bearer/JWT/失効/ユーザー確認）。REST形式。",
      content: { "application/json": { schema: restError } },
    },
    "403": {
      description: "FORBIDDEN（cid付きservice token）。REST形式。",
      content: { "application/json": { schema: restError } },
    },
    "404": {
      description: "INVALID_CODE（コードが存在しない）。REST形式。",
      content: { "application/json": { schema: restError } },
    },
    "500": {
      description:
        "REST INTERNAL_ERROR/MISCONFIGURATION、または既存catchの{error:INTERNAL_ERROR}。",
      content: {
        "application/json": {
          schema: {
            anyOf: [
              restError,
              {
                type: "object",
                properties: { error: { type: "string", enum: ["INTERNAL_ERROR"] } },
                required: ["error"],
              },
            ],
          },
        },
      },
    },
    ...transportErrors,
  },
};

export const USERINFO_GET_OPERATION = {
  tags: ["OIDC"],
  summary: "UserInfo（既存GET/POST共通ハンドラー）",
  description:
    "Authorization: Bearerヘッダーのみ。POSTの本文を読まず、本文access_tokenは認証に使わない。" +
    "現在の共通認証はES256署名、iss=IDP_ORIGIN、aud=IDP_ORIGIN、期限/失効を検証する。" +
    "標準service tokenはaud=client_idで発行されるため、そのままこのaudience検証を通るとは保証しない。\n" +
    "認証を通ったtokenにcidがあればサービス固有pairwise sub、cidがなければ内部ユーザーIDを返す。" +
    "scope未指定/空ならname/picture/email/email_verifiedを返す。" +
    "profileはname/picture、emailはemail/email_verified、phoneは非nullのphone_number、addressは非nullの{formatted}。" +
    "phone/address未保持時はキーを省略する。sub/updated_atは常に含む。data包み・role・provider IDsは返さない。",
  security: [{ BearerAuth: [] }],
  responses: {
    "200": {
      description: "スコープに応じたflatなユーザークレーム。",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              sub: { type: "string", description: "cidの有無でpairwise/internalを選ぶ。" },
              updated_at: { type: "integer", description: "Unix秒。" },
              name: { type: "string" },
              picture: { type: ["string", "null"] },
              email: { type: "string" },
              email_verified: { type: "boolean" },
              phone_number: { type: "string", description: "phone scopeかつ非nullの場合のみ。" },
              address: {
                type: "object",
                properties: { formatted: { type: "string" } },
                required: ["formatted"],
                description: "address scopeかつ非nullの場合のみ。",
              },
            },
            required: ["sub", "updated_at"],
          },
        },
      },
    },
    "401": {
      description:
        "認証middlewareのREST UNAUTHORIZED、または不存在/停止ユーザーのOAuth invalid_token。",
      content: { "application/json": { schema: mixedError } },
    },
    "500": {
      description: "ユーザー取得のOAuth server_error、または共通RESTエラー。",
      content: { "application/json": { schema: mixedError } },
    },
    ...transportErrors,
  },
};
export const USERINFO_POST_OPERATION = {
  ...USERINFO_GET_OPERATION,
  summary: "UserInfo（POST、本文のtokenは使わない）",
};
