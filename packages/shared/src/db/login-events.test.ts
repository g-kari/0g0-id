import { describe, it, expect, vi } from 'vitest';
import { insertLoginEvent, getLoginEventsByUserId } from './login-events';
import type { LoginEvent } from '../types';

function makeD1Mock(
  firstResult: unknown = null,
  allResults: unknown[] = [],
  changes = 1
): D1Database {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    all: vi.fn().mockResolvedValue({ results: allResults }),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
}

const baseLoginEvent: LoginEvent = {
  id: 'event-id-1',
  user_id: 'user-1',
  provider: 'google',
  ip_address: '1.2.3.4',
  user_agent: 'Mozilla/5.0',
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
      'Mozilla/5.0'
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
      'Chrome/120'
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
      null
    );
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
});
