const SESSION_TTL_MS = 30 * 60 * 1000; // 30分

export async function createMcpSession(db: D1Database, sessionId: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare('INSERT INTO mcp_sessions (id, created_at, last_active_at) VALUES (?, ?, ?)')
    .bind(sessionId, now, now)
    .run();
}

export async function validateAndRefreshMcpSession(
  db: D1Database,
  sessionId: string
): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - SESSION_TTL_MS;
  const result = await db
    .prepare(
      'UPDATE mcp_sessions SET last_active_at = ? WHERE id = ? AND last_active_at > ? RETURNING id'
    )
    .bind(now, sessionId, cutoff)
    .first<{ id: string }>();
  return result !== null;
}

export async function deleteMcpSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM mcp_sessions WHERE id = ?').bind(sessionId).run();
}

export async function cleanupExpiredMcpSessions(db: D1Database): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  await db.prepare('DELETE FROM mcp_sessions WHERE last_active_at <= ?').bind(cutoff).run();
}
