import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from '@0g0-id/shared';
import type { TokenPayload } from '@0g0-id/shared';
import { McpServer, createMcpRoutes, type McpContext } from './mcp';
import wellKnownRoutes from './routes/well-known';
import { mcpAuthMiddleware, mcpAdminMiddleware, mcpRejectBannedUserMiddleware } from './middleware/auth';
import {
  listUsersTool,
  getUserTool,
  banUserTool,
  unbanUserTool,
  deleteUserTool,
  getUserLoginHistoryTool,
  getUserProvidersTool,
  listUserSessionsTool,
  revokeUserSessionsTool,
  listServicesTool,
  getServiceTool,
  createServiceTool,
  deleteServiceTool,
  rotateServiceSecretTool,
  getAuditLogsTool,
  getAuditStatsTool,
  getSystemMetricsTool,
} from './tools';

type Env = {
  Bindings: {
    DB: D1Database;
    IDP: Fetcher;
    IDP_ORIGIN: string;
    MCP_ORIGIN: string;
  };
  Variables: {
    mcpContext: McpContext;
    user: TokenPayload;
  };
};

const appLogger = createLogger('mcp');

// MCPサーバーインスタンス
const mcpServer = new McpServer();

// ユーザー管理ツールを登録
mcpServer.registerTool(listUsersTool);
mcpServer.registerTool(getUserTool);
mcpServer.registerTool(banUserTool);
mcpServer.registerTool(unbanUserTool);
mcpServer.registerTool(deleteUserTool);
mcpServer.registerTool(getUserLoginHistoryTool);
mcpServer.registerTool(getUserProvidersTool);
mcpServer.registerTool(listUserSessionsTool);
mcpServer.registerTool(revokeUserSessionsTool);

// サービス管理ツールを登録
mcpServer.registerTool(listServicesTool);
mcpServer.registerTool(getServiceTool);
mcpServer.registerTool(createServiceTool);
mcpServer.registerTool(deleteServiceTool);
mcpServer.registerTool(rotateServiceSecretTool);

// 監査ログツールを登録
mcpServer.registerTool(getAuditLogsTool);
mcpServer.registerTool(getAuditStatsTool);

// メトリクスツールを登録
mcpServer.registerTool(getSystemMetricsTool);

const app = new Hono<Env>();

// CORS: MCPオリジンのみ許可
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowed = c.env.MCP_ORIGIN;
      return origin === allowed ? origin : '';
    },
  }),
);

// Health check
app.get('/health', (c): Response => {
  return c.json({ status: 'ok', worker: 'mcp', timestamp: new Date().toISOString() });
});

// Protected Resource Metadata (RFC 9728)
app.route('/.well-known', wellKnownRoutes);

// MCP ルート: Bearer token 認証 + 管理者ロール必須 + BAN拒否 + コンテキスト設定
app.use('/mcp/*', mcpAuthMiddleware);
app.use('/mcp/*', mcpRejectBannedUserMiddleware);
app.use('/mcp/*', mcpAdminMiddleware);
app.use('/mcp/*', async (c, next): Promise<void> => {
  const user = c.get('user');
  const context: McpContext = {
    userId: user.sub,
    userRole: user.role,
    db: c.env.DB,
    idp: c.env.IDP,
  };
  c.set('mcpContext', context);
  await next();
});

// MCPルートをマウント
app.route('/mcp', createMcpRoutes(mcpServer));

app.onError((err, c): Response => {
  appLogger.error('Unhandled error', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
