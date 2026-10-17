// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { apiFetch, formatDate, formatDatetime } from "./api";

// --- helpers -----------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

// --- setup / teardown --------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);

  // writable window.location
  Object.defineProperty(window, "location", {
    value: { href: "" },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

// =======================================================================
// apiFetch
// =======================================================================

describe("apiFetch", () => {
  // 1. 正常系 ─ { data: T } を返す
  it("正常レスポンスから data を返す", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 1, name: "test" } }));

    const result = await apiFetch<{ id: number; name: string }>("/api/test");

    expect(result).toEqual({ id: 1, name: "test" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // 2. 204 No Content → undefined
  it("204 の場合 undefined を返す", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));

    const result = await apiFetch("/api/test", { method: "DELETE" });

    expect(result).toBeUndefined();
  });

  // 3. TOKEN_ROTATED リトライ
  it("503 TOKEN_ROTATED → 400ms 後にリトライして成功する", async () => {
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "TOKEN_ROTATED", message: "rotated" } }, 503),
      )
      .mockResolvedValueOnce(jsonResponse({ data: "ok" }));

    const promise = apiFetch<string>("/api/test");

    // 400ms タイマーを進める
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 4. DBSC_BINDING_REQUIRED リトライ（成功パターン）
  it("403 DBSC_BINDING_REQUIRED → リバインドリトライして成功する", async () => {
    vi.useFakeTimers();

    const dbscBody = { error: { code: "DBSC_BINDING_REQUIRED", message: "rebind" } };

    fetchMock
      // 初回 403
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      // リトライ 1 回目（500ms 後）→ まだ 403
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      // リトライ 2 回目（1500ms 後）→ 成功
      .mockResolvedValueOnce(jsonResponse({ data: "rebound" }));

    const promise = apiFetch<string>("/api/test");

    // 500ms → 1st retry
    await vi.advanceTimersByTimeAsync(500);
    // 1500ms → 2nd retry
    await vi.advanceTimersByTimeAsync(1500);

    const result = await promise;
    expect(result).toBe("rebound");
    // 初回 + リトライ2回 = 3回
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // DBSC: ヘッダーなし → warn して元のレスポンスを返す
  it("403 DBSC_BINDING_REQUIRED でヘッダーなし → 日本語エラーを throw する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const dbscBody = { error: { code: "DBSC_BINDING_REQUIRED", message: "rebind" } };
    fetchMock.mockResolvedValueOnce(jsonResponse(dbscBody, 403));

    await expect(apiFetch("/api/test")).rejects.toThrow(
      "端末の確認が必要です。Chrome で一度ログアウトし、再度ログインしてください。",
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("without Secure-Session-Registration"),
    );
  });

  // 5. 401 → リダイレクトして Unauthorized throw
  it("401 → window.location.href を / に設定して Unauthorized を throw する", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(401));

    await expect(apiFetch("/api/test")).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/");
  });

  // 6. 非 ok でエラーボディあり → error.message を throw
  it("エラーボディの message を throw する", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid input" } }, 400),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow("invalid input");
  });

  // 7. 非 ok でパース不能 → HTTP {status}
  it("パース不能な非 ok レスポンスは HTTP {status} を throw する", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }));

    await expect(apiFetch("/api/test")).rejects.toThrow("HTTP 500");
  });

  // 8. DBSC_BINDING_REQUIRED が非 ok で返る → 日本語メッセージ
  it("非 ok で DBSC_BINDING_REQUIRED → 日本語メッセージを throw する", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "DBSC_BINDING_REQUIRED", message: "rebind needed" } }, 400),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow(
      "端末の確認が必要です。Chrome で一度ログアウトし、再度ログインしてください。",
    );
  });

  // doFetch のオプション伝搬
  it("credentials: same-origin と Content-Type ヘッダーを付与する", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));

    await apiFetch("/api/test", { method: "POST", body: JSON.stringify({ x: 1 }) });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  // TOKEN_ROTATED: 503 でも code が異なれば通常エラー
  it("503 で TOKEN_ROTATED 以外のコードはリトライしない", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "OTHER", message: "something" } }, 503),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow("something");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // DBSC リトライ: 途中で非 403 が返る → その時点で終了
  it("DBSC リトライ中に非 403 が返れば即座に返す", async () => {
    vi.useFakeTimers();

    const dbscBody = { error: { code: "DBSC_BINDING_REQUIRED", message: "rebind" } };

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      // リトライ 1 回目 → 200 で成功
      .mockResolvedValueOnce(jsonResponse({ data: "early" }));

    const promise = apiFetch<string>("/api/test");
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result).toBe("early");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // DBSC リトライ: 途中で 403 だがコードが異なる → その時点で返す
  it("DBSC リトライ中に 403 だが別コードならそこで返す", async () => {
    vi.useFakeTimers();

    const dbscBody = { error: { code: "DBSC_BINDING_REQUIRED", message: "rebind" } };

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      // リトライ 1 回目 → 403 だが FORBIDDEN
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "FORBIDDEN", message: "no access" } }, 403),
      );

    const promise = apiFetch("/api/test");
    // rejection handler を先に登録して unhandled rejection を防ぐ
    const assertion = expect(promise).rejects.toThrow("no access");
    await vi.advanceTimersByTimeAsync(500);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // DBSC リトライ: リトライ全部使い切り → 最後のレスポンスを返す
  it("DBSC リトライを使い切ったら最後のレスポンスで処理を続行する", async () => {
    vi.useFakeTimers();

    const dbscBody = { error: { code: "DBSC_BINDING_REQUIRED", message: "rebind" } };

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(dbscBody, 403, { "Secure-Session-Registration": "reg=start" }),
      );

    const promise = apiFetch("/api/test");
    // rejection handler を先に登録して unhandled rejection を防ぐ
    const assertion = expect(promise).rejects.toThrow(
      "端末の確認が必要です。Chrome で一度ログアウトし、再度ログインしてください。",
    );
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// =======================================================================
// formatDate / formatDatetime
// =======================================================================

describe("formatDate", () => {
  it("ISO 文字列を ja-JP の日付形式に変換する", () => {
    const result = formatDate("2025-01-15T10:30:00Z");
    // ja-JP → "2025/01/15" 形式
    expect(result).toMatch(/2025\/01\/15/);
  });
});

describe("formatDatetime", () => {
  it("ISO 文字列を ja-JP の日時形式に変換する", () => {
    const result = formatDatetime("2025-01-15T10:30:00Z");
    // ja-JP → "2025/01/15 HH:MM" 形式
    expect(result).toMatch(/2025\/01\/15/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});
