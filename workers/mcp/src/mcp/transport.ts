import { Hono } from 'hono';
import { McpServer, type McpContext } from './server';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from './types';
import {
  createMcpSession,
  validateAndRefreshMcpSession,
  deleteMcpSession,
} from '@0g0-id/shared';

type McpBindings = {
  DB: D1Database;
};

type McpEnv = {
  Bindings: McpBindings;
  Variables: {
    mcpContext: McpContext;
  };
};

export function createMcpRoutes(server: McpServer): Hono<McpEnv> {
  const app = new Hono<McpEnv>();

  // POST /mcp — JSON-RPCリクエスト処理
  app.post('/', async (c): Promise<Response> => {
    const sessionId = c.req.header('mcp-session-id');
    const body: JsonRpcRequest | JsonRpcNotification | (JsonRpcRequest | JsonRpcNotification)[] =
      await c.req.json();

    // バッチリクエスト対応
    const requests: (JsonRpcRequest | JsonRpcNotification)[] = Array.isArray(body) ? body : [body];

    const responses: JsonRpcResponse[] = [];
    for (const req of requests) {
      // Notification (idなし) はレスポンス不要
      if (!('id' in req)) {
        // notifications/initialized 等のハンドリング
        continue;
      }

      const rpcRequest = req as JsonRpcRequest;

      // initializeの場合、新セッション作成
      if (rpcRequest.method === 'initialize') {
        const newSessionId = crypto.randomUUID();
        const context = c.get('mcpContext');
        await createMcpSession(c.env.DB, newSessionId, context.userId);
        const result = await server.handleRequest(rpcRequest, c.get('mcpContext'));
        c.header('Mcp-Session-Id', newSessionId);
        responses.push(result);
        continue;
      }

      // initialize以外はセッションID必須
      if (!sessionId) {
        responses.push({
          jsonrpc: '2.0',
          id: rpcRequest.id,
          error: { code: -32600, message: 'Invalid or missing session' },
        });
        continue;
      }

      // セッション検証＆アイドルタイムアウトのスライディングウィンドウ更新
      const valid = await validateAndRefreshMcpSession(c.env.DB, sessionId);
      if (!valid) {
        responses.push({
          jsonrpc: '2.0',
          id: rpcRequest.id,
          error: { code: -32600, message: 'Invalid or missing session' },
        });
        continue;
      }

      const result = await server.handleRequest(rpcRequest, c.get('mcpContext'));
      responses.push(result);
    }

    if (responses.length === 0) {
      return c.body(null, 202);
    }
    if (responses.length === 1) {
      return c.json(responses[0]);
    }
    return c.json(responses);
  });

  // GET /mcp — SSEストリーム（将来のサーバー→クライアント通知用）
  app.get('/', async (c): Promise<Response> => {
    const sessionId = c.req.header('mcp-session-id');
    if (!sessionId) {
      return c.json({ error: 'Invalid session' }, 400);
    }
    const valid = await validateAndRefreshMcpSession(c.env.DB, sessionId);
    if (!valid) {
      return c.json({ error: 'Invalid session' }, 400);
    }
    // 現時点ではサーバーからの通知は不要なので、接続を維持するだけ
    return new Response(
      new ReadableStream({
        start(controller): void {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(': keepalive\n\n'));
          // Cloudflare Workersではlong-livedストリームは制限があるため、
          // 現時点ではシンプルなSSE keepaliveのみ
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      },
    );
  });

  // DELETE /mcp — セッション終了
  app.delete('/', async (c): Promise<Response> => {
    const sessionId = c.req.header('mcp-session-id');
    if (sessionId) {
      await deleteMcpSession(c.env.DB, sessionId);
    }
    return c.body(null, 204);
  });

  return app;
}
