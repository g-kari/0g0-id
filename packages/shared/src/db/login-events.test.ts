import { describe, it, expect, vi } from 'vitest';
import { insertLoginEvent, getLoginEventsByUserId, countRecentLoginEvents } from './login-events';
import type { LoginEvent } from '../types';
import { makeD1Mock } from './test-helpers';

const baseLoginEvent: LoginEvent = {
  id: 'event-id-1',
  user_id: 'user-1',
  provider: 'google',
  ip_address: '1.2.3.4',
  user_agent: 'Mozilla/5.0',
  country: null,
  created_at: '2024-01-01T00:00:00Z',
};

describe('insertLoginEvent', () => {
  it('INSERT文を実行してログインイベントを記録する', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'google',
      ipAddress: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
    });

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO login_events'));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String), // UUIDは動的に生成
      'user-1',
      'google',
      '1.2.3.4',
      'Mozilla/5.0',
      null
    );
    expect(stmt.run).toHaveBeenCalled();
  });

  it('ipAddressがnullの場合もnullでbindする', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'github',
      ipAddress: null,
      userAgent: 'Chrome/120',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'github',
      null,
      'Chrome/120',
      null
    );
  });

  it('userAgentがnullの場合もnullでbindする', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'line',
      ipAddress: '10.0.0.1',
      userAgent: null,
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'line',
      '10.0.0.1',
      null,
      null
    );
  });

  it('ipAddressとuserAgentが省略された場合はnullでbindする', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'twitch',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'twitch',
      null,
      null,
      null
    );
  });

  it('countryを指定した場合はbindに渡される', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'google',
      ipAddress: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      country: 'JP',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'google',
      '1.2.3.4',
      'Mozilla/5.0',
      'JP'
    );
  });

  it('countryが省略された場合はnullでbindする', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, {
      userId: 'user-1',
      provider: 'google',
      ipAddress: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[5]).toBeNull();
  });

  it('idにUUIDを使用する', async () => {
    const db = makeD1Mock();
    await insertLoginEvent(db, { userId: 'user-1', provider: 'google' });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const boundId = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // UUID形式（8-4-4-4-12文字の16進数）
    expect(boundId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('getLoginEventsByUserId', () => {
  it('ユーザーのログインイベント一覧とtotalを返す', async () => {
    const mockEvents = [baseLoginEvent];

    // 2回のqueryをモックする: 1回目はall（イベント一覧）、2回目はfirst（count）
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockEvents }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await getLoginEventsByUserId(db, 'user-1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('event-id-1');
    expect(result.events[0].provider).toBe('google');
    expect(result.total).toBe(1);
  });

  it('ログインイベントがない場合はevents=[]・total=0を返す', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await getLoginEventsByUserId(db, 'user-no-events');
    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('デフォルトlimit=20・offset=0でbindする', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-1');
    expect(eventsStmt.bind).toHaveBeenCalledWith('user-1', 20, 0);
  });

  it('limit・offsetを指定できる', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 50 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await getLoginEventsByUserId(db, 'user-1', 5, 10);
    expect(eventsStmt.bind).toHaveBeenCalledWith('user-1', 5, 10);
    expect(result.total).toBe(50);
  });

  it('SQLにORDER BY created_at DESCが含まれる', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-1');
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('userIdでcountクエリをbindする', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 3 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-xyz');
    expect(countStmt.bind).toHaveBeenCalledWith('user-xyz');
  });

  it('複数のイベントを正しく返す', async () => {
    const mockEvents: LoginEvent[] = [
      { ...baseLoginEvent, id: 'event-2', created_at: '2024-02-01T00:00:00Z' },
      { ...baseLoginEvent, id: 'event-1', created_at: '2024-01-01T00:00:00Z' },
    ];
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockEvents }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 2 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await getLoginEventsByUserId(db, 'user-1');
    expect(result.events).toHaveLength(2);
    expect(result.events[0].id).toBe('event-2');
    expect(result.events[1].id).toBe('event-1');
    expect(result.total).toBe(2);
  });

  it('providerを指定するとSQLにAND provider = ?が含まれる', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-1', 20, 0, 'google');
    const eventsSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const countSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(eventsSql).toContain('AND provider = ?');
    expect(countSql).toContain('AND provider = ?');
  });

  it('providerを指定するとeventsクエリにproviderをbindする', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-1', 10, 5, 'github');
    expect(eventsStmt.bind).toHaveBeenCalledWith('user-1', 'github', 10, 5);
    expect(countStmt.bind).toHaveBeenCalledWith('user-1', 'github');
  });

  it('providerなしの場合はproviderをbindしない', async () => {
    const eventsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(eventsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await getLoginEventsByUserId(db, 'user-1', 20, 0);
    expect(eventsStmt.bind).toHaveBeenCalledWith('user-1', 20, 0);
    expect(countStmt.bind).toHaveBeenCalledWith('user-1');
  });
});

describe('countRecentLoginEvents', () => {
  it('指定日時以降のログインイベント数を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 7 }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const result = await countRecentLoginEvents(db, '2024-01-01T00:00:00.000Z');
    expect(result).toBe(7);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'));
    expect(stmt.bind).toHaveBeenCalledWith('2024-01-01T00:00:00.000Z');
  });

  it('イベントがない場合は0を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const result = await countRecentLoginEvents(db, '2024-01-01T00:00:00.000Z');
    expect(result).toBe(0);
  });

  it('first()がnullを返した場合は0にフォールバックする', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const result = await countRecentLoginEvents(db, '2024-01-01T00:00:00.000Z');
    expect(result).toBe(0);
  });

  it('SQLにcreated_at >= ?の条件が含まれる', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 3 }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    await countRecentLoginEvents(db, '2024-06-01T00:00:00.000Z');
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('created_at >=');
  });
});


describe('getLoginEventProviderStats', () => {
  it('プロバイダー別のログイン統計を返す', async () => {
    const mockStats = [
      { provider: 'google', count: 10 },
      { provider: 'line', count: 3 },
      { provider: 'github', count: 1 },
    ];
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockStats }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    // dynamic import to pick up the newly added export
    const { getLoginEventProviderStats } = await import('./login-events');
    const result = await getLoginEventProviderStats(db, '2024-01-01T00:00:00.000Z');

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ provider: 'google', count: 10 });
    expect(result[1]).toEqual({ provider: 'line', count: 3 });
    expect(result[2]).toEqual({ provider: 'github', count: 1 });
  });

  it('ログインイベントがない場合は空配列を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getLoginEventProviderStats } = await import('./login-events');
    const result = await getLoginEventProviderStats(db, '2099-01-01T00:00:00.000Z');

    expect(result).toEqual([]);
  });

  it('sinceIsoをbindパラメータとして渡す', async () => {
    const since = '2024-06-01T00:00:00.000Z';
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getLoginEventProviderStats } = await import('./login-events');
    await getLoginEventProviderStats(db, since);

    expect(stmt.bind).toHaveBeenCalledWith(since);
  });

  it('SQLにGROUP BY providerが含まれる', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getLoginEventProviderStats } = await import('./login-events');
    await getLoginEventProviderStats(db, '2024-01-01T00:00:00.000Z');

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('GROUP BY provider');
  });
});

describe('getUserLoginProviderStats', () => {
  it('ユーザーのプロバイダー別ログイン統計を返す', async () => {
    const mockStats = [
      { provider: 'google', count: 5 },
      { provider: 'github', count: 2 },
    ];
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockStats }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getUserLoginProviderStats } = await import('./login-events');
    const result = await getUserLoginProviderStats(db, 'user-1', '2024-01-01T00:00:00.000Z');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ provider: 'google', count: 5 });
    expect(result[1]).toEqual({ provider: 'github', count: 2 });
  });

  it('ログインイベントがない場合は空配列を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getUserLoginProviderStats } = await import('./login-events');
    const result = await getUserLoginProviderStats(db, 'user-1', '2099-01-01T00:00:00.000Z');

    expect(result).toEqual([]);
  });

  it('userId と sinceIso を bind パラメータとして渡す', async () => {
    const since = '2024-06-01T00:00:00.000Z';
    const userId = 'user-abc';
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getUserLoginProviderStats } = await import('./login-events');
    await getUserLoginProviderStats(db, userId, since);

    expect(stmt.bind).toHaveBeenCalledWith(userId, since);
  });

  it('SQL に user_id フィルターと GROUP BY provider が含まれる', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getUserLoginProviderStats } = await import('./login-events');
    await getUserLoginProviderStats(db, 'user-1', '2024-01-01T00:00:00.000Z');

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('user_id = ?');
    expect(sql).toContain('GROUP BY provider');
  });
});

describe('getDailyLoginTrends', () => {
  it('日別ログイン統計を日付昇順で返す', async () => {
    const mockStats = [
      { date: '2024-01-01', count: 5 },
      { date: '2024-01-02', count: 8 },
      { date: '2024-01-03', count: 3 },
    ];
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockStats }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getDailyLoginTrends } = await import('./login-events');
    const result = await getDailyLoginTrends(db, 30);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ date: '2024-01-01', count: 5 });
    expect(result[2]).toEqual({ date: '2024-01-03', count: 3 });
  });

  it('ログインイベントがない場合は空配列を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getDailyLoginTrends } = await import('./login-events');
    const result = await getDailyLoginTrends(db, 7);

    expect(result).toEqual([]);
  });

  it('デフォルトdays=30でsinceIsoをbindする', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const before = Date.now();
    const { getDailyLoginTrends } = await import('./login-events');
    await getDailyLoginTrends(db);
    const after = Date.now();

    const boundSince: string = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const boundMs = new Date(boundSince).getTime();
    expect(boundMs).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
    expect(boundMs).toBeLessThanOrEqual(after - 30 * 24 * 60 * 60 * 1000);
  });

  it('days=7を指定すると7日前のsinceIsoをbindする', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const before = Date.now();
    const { getDailyLoginTrends } = await import('./login-events');
    await getDailyLoginTrends(db, 7);
    const after = Date.now();

    const boundSince: string = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const boundMs = new Date(boundSince).getTime();
    expect(boundMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(boundMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it('SQLにstrftime・GROUP BY date・ORDER BY date ASCが含まれる', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const { getDailyLoginTrends } = await import('./login-events');
    await getDailyLoginTrends(db, 30);

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("strftime('%Y-%m-%d'");
    expect(sql).toContain('GROUP BY date');
    expect(sql).toContain('ORDER BY date ASC');
  });
});
