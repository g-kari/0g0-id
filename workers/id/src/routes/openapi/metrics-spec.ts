// Static documentation only. Runtime handlers and query parsing live in ../metrics.ts.
// Keep the existing IdP contract, including its differences from the admin BFF.
type Schema = Record<string, unknown>;
type Parameter = { name: string; in: string; description: string; schema: Schema };

const count = { type: "integer", minimum: 0 };
const dateCount = {
  type: "object",
  required: ["date", "count"],
  properties: { date: { type: "string", format: "date" }, count },
};
const authDescription =
  "管理者専用。IdP 向け Bearer JWT と admin ロールが必要。失効・jti 欠落・DB 上の BAN/不存在は拒否する。";

function errorResponse(description: string, code: string | string[]): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Array.isArray(code) ? code : [code] },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function operation(
  summary: string,
  description: string,
  data: Schema,
  parameters: Parameter[] = [],
  extra: Record<string, Schema> = {},
  invalidCode?: string,
): Record<string, unknown> {
  return {
    tags: ["管理者 API"],
    summary,
    description: `${authDescription}\n\n${description}`,
    security: [{ BearerAuth: [] }],
    parameters,
    responses: {
      "200": {
        description: "集計結果。該当する行がない配列は空配列。",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["data", ...Object.keys(extra)],
              properties: { data, ...extra },
            },
          },
        },
      },
      ...(invalidCode
        ? { "400": errorResponse(`${invalidCode} — クエリー値不正`, invalidCode) }
        : {}),
      "401": errorResponse("UNAUTHORIZED — 認証失敗・失効・アカウント停止等", "UNAUTHORIZED"),
      "403": errorResponse("FORBIDDEN — 管理者権限なし", "FORBIDDEN"),
      "500": errorResponse(
        "INTERNAL_ERROR — 集計の取得失敗。アプリ全体の環境検証失敗は MISCONFIGURATION。",
        ["INTERNAL_ERROR", "MISCONFIGURATION"],
      ),
    },
  };
}

function daysParameter(maximum: number, defaultDays = 30): Parameter {
  return {
    name: "days",
    in: "query",
    description: `省略時 ${defaultDays}。ASCII 数字のみ。空・小数・符号・範囲外は 400 INVALID_REQUEST。クランプしない。`,
    schema: { type: "integer", minimum: 1, maximum, default: defaultDays },
  };
}

function dailyOperation(
  summary: string,
  description: string,
  maximum: number,
): Record<string, unknown> {
  return operation(
    summary,
    `${description} 日付昇順。0 件の日は補完しない。days はリクエスト時刻からの期間。既存 SQL は保存日時文字列を ISO 下限と比較し、混在形式の境界を正規化しない。`,
    { type: "array", items: dateCount },
    [daysParameter(maximum)],
    { days: { type: "integer", minimum: 1, maximum, default: 30 } },
    "INVALID_REQUEST",
  );
}

function groupedOperation(
  summary: string,
  description: string,
  row: Schema,
): Record<string, unknown> {
  const days = daysParameter(365, 7);
  days.description =
    "省略時 7。ASCII 数字のみ。空・小数・符号・1〜365 以外は 400 INVALID_PARAMETER。クランプしない。";
  return operation(
    summary,
    `${description} count 降順。同数時の順序は規定しない。期間判定は保存日時文字列と ISO 下限の比較で、混在形式の境界を正規化しない。`,
    { type: "array", items: row },
    [
      days,
      {
        name: "limit",
        in: "query",
        description:
          "省略時 20。ASCII 数字のみ。空・小数・符号・1〜100 以外は 400 INVALID_PARAMETER。クランプしない。",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    ],
    {
      meta: {
        type: "object",
        required: ["days", "limit"],
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, default: 7 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    "INVALID_PARAMETER",
  );
}

export const ADDITIONAL_METRICS_PATHS = {
  "/api/metrics/login-trends": {
    get: dailyOperation(
      "日別ログイン件数",
      "login_events の件数（成功/失敗を区別しない）。IdP は最大 365 日。admin BFF は最大 90 日で事前検証する。",
      365,
    ),
  },
  "/api/metrics/services": {
    get: operation(
      "サービス別アクティブトークン統計",
      "全サービスを返す。authorized_user_count は未失効・未期限切れのリフレッシュトークンを持つユニークユーザー数で、認可履歴の総数ではない。active_token_count は同じ条件のトークン数。authorized_user_count 降順。同数時の順序は規定しない。",
      {
        type: "array",
        items: {
          type: "object",
          required: ["service_id", "service_name", "authorized_user_count", "active_token_count"],
          properties: {
            service_id: { type: "string" },
            service_name: { type: "string" },
            authorized_user_count: count,
            active_token_count: count,
          },
        },
      },
    ),
  },
  "/api/metrics/suspicious-logins": {
    get: operation(
      "複数国ログインの集計",
      "login_events を user_id ごとに集計し、異なる国が min_countries 以上の行を返す。成功/失敗を区別せず、国 NULL は unknown として数える。country_count 降順。countries は重複を除いたカンマ区切り文字列で順序は規定しない。疑わしい傾向の集計であり、不正アクセス確定や自動停止ではない。期間判定は保存日時文字列と ISO 下限の比較で、混在形式の境界を正規化しない。\n\n" +
        "IdP は各値を parseInt(value, 10) で解釈する。非数値・空・省略は既定値、数値の接頭辞（例 24hours）は受理し、小数は整数部分になる。hours は 1〜168、min_countries は 2〜10 にクランプし、適用値を meta に返す。このため入力の範囲外を 400 で拒否しない。admin BFF は別途、数字のみ・hours 1〜720・min_countries 1〜100 を検証して転送する。",
      {
        type: "array",
        items: {
          type: "object",
          required: ["user_id", "country_count", "countries"],
          properties: {
            user_id: { type: "string" },
            country_count: { type: "integer", minimum: 2 },
            countries: { type: "string", description: "カンマ区切り。unknown を含み得る。" },
          },
        },
      },
      [
        {
          name: "hours",
          in: "query",
          description:
            "parseInt 後 1〜168 にクランプ。NaN は 24。任意文字列を受理する既存の解析規則。",
          schema: { type: "string", default: "24" },
        },
        {
          name: "min_countries",
          in: "query",
          description: "parseInt 後 2〜10 にクランプ。NaN は 2。",
          schema: { type: "string", default: "2" },
        },
      ],
      {
        meta: {
          type: "object",
          required: ["hours", "min_countries"],
          properties: {
            hours: { type: "integer", minimum: 1, maximum: 168, default: 24 },
            min_countries: { type: "integer", minimum: 2, maximum: 10, default: 2 },
          },
        },
      },
    ),
  },
  "/api/metrics/user-registrations": {
    get: dailyOperation(
      "日別ユーザー登録数",
      "users の作成日時を日別に集計する。IdP は最大 365 日。admin BFF は最大 90 日で事前検証する。",
      365,
    ),
  },
  "/api/metrics/active-users": {
    get: operation(
      "アクティブユーザー数（DAU/WAU/MAU）",
      "login_events のユニーク user_id 数。dau は直近 24 時間、wau は 7 日、mau は 30 日。暦日/暦週/月初からの集計ではない。成功/失敗を区別しない。期間判定は保存日時文字列と ISO 下限の比較で、混在形式の境界を正規化しない。",
      {
        type: "object",
        required: ["dau", "wau", "mau"],
        properties: { dau: count, wau: count, mau: count },
      },
    ),
  },
  "/api/metrics/active-users/daily": {
    get: dailyOperation(
      "日別アクティブユーザー数",
      "日ごとの login_events のユニーク user_id 数。成功/失敗を区別しない。",
      90,
    ),
  },
  "/api/metrics/ip-stats": {
    get: groupedOperation(
      "IP 別ログイン件数",
      "login_events の IP 別集計。IP が NULL のイベントを除外する（空文字列は除外しない）。成功/失敗を区別しない。last_seen は保存済み created_at の MAX で、日時形式やタイムゾーンを正規化しない。",
      {
        type: "object",
        required: ["ip_address", "count", "last_seen"],
        properties: {
          ip_address: { type: "string" },
          count,
          last_seen: {
            type: "string",
            description: "保存済み日時文字列。SQLite 形式と ISO 形式があり得る。",
          },
        },
      },
    ),
  },
  "/api/metrics/user-agent-stats": {
    get: groupedOperation(
      "User-Agent 別ログイン件数",
      "login_events の User-Agent 別集計。User-Agent が NULL のイベントを除外する（空文字列は除外しない）。成功/失敗を区別しない。",
      {
        type: "object",
        required: ["user_agent", "count"],
        properties: { user_agent: { type: "string" }, count },
      },
    ),
  },
};
