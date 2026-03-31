import { describe, it, expect, vi } from 'vitest';
import { createAdminAuditLog, listAdminAuditLogs } from './admin-audit-logs';
import type { AdminAuditLog } from '../types';
import { makeD1Mock } from './test-helpers';

const baseLog: AdminAuditLog = {
  id: 'log-id-1',
  admin_user_id: 'admin-1',
  action: 'user.update',
  target_type: 'user',
  target_id: 'user-42',
  details: null,
  ip_address: '1.2.3.4',
  status: 'success',
  created_at: '2024-01-01T00:00:00Z',
};

describe('createAdminAuditLog', () => {
  it('INSERT文を実行して監査ログを記録する', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'user.update',
      targetType: 'user',
      targetId: 'user-42',
    });

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_logs')
    );
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.run).toHaveBeenCalled();
  });

  it('idにUUIDを使用する', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'service.delete',
      targetType: 'service',
      targetId: 'svc-1',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const boundId = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(boundId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('必須フィールドを正しくbindする', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-2',
      action: 'role.change',
      targetType: 'user',
      targetId: 'user-99',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      expect.any(String), // UUID
      'admin-2',
      'role.change',
      'user',
      'user-99',
      null,       // details省略 → null
      null,       // ipAddress省略 → null
      'success'   // status省略 → 'success'
    );
  });

  it('detailsをJSON文字列にシリアライズしてbindする', async () => {
    const db = makeD1Mock();
    const details = { before: 'user', after: 'admin' };
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'role.change',
      targetType: 'user',
      targetId: 'user-1',
      details,
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[5]).toBe(JSON.stringify(details));
  });

  it('details=nullの場合はnullでbindする', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'user.delete',
      targetType: 'user',
      targetId: 'user-1',
      details: null,
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[5]).toBeNull();
  });

  it('ipAddressを指定した場合はbindに渡される', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'user.suspend',
      targetType: 'user',
      targetId: 'user-1',
      ipAddress: '10.0.0.1',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[6]).toBe('10.0.0.1');
  });

  it('ipAddressが省略された場合はnullでbindする', async () => {
    const db = makeD1Mock();
    await createAdminAuditLog(db, {
      adminUserId: 'admin-1',
      action: 'user.update',
      targetType: 'user',
      targetId: 'user-1',
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs[6]).toBeNull();
  });
});

describe('listAdminAuditLogs', () => {
  it('監査ログ一覧とtotalを返す', async () => {
    const mockLogs: AdminAuditLog[] = [baseLog];
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockLogs }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await listAdminAuditLogs(db);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].id).toBe('log-id-1');
    expect(result.total).toBe(1);
  });

  it('ログがない場合はlogs=[]・total=0を返す', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await listAdminAuditLogs(db);
    expect(result.logs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('デフォルトlimit=50・offset=0でbindする', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db);
    expect(logsStmt.bind).toHaveBeenCalledWith(50, 0);
  });

  it('limit・offsetを指定できる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 100 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await listAdminAuditLogs(db, 10, 20);
    expect(logsStmt.bind).toHaveBeenCalledWith(10, 20);
    expect(result.total).toBe(100);
  });

  it('SQLにORDER BY created_at DESC, id DESCが含まれる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db);
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('id DESC');
  });

  it('adminUserIdフィルターを指定するとSQLにWHERE admin_user_id = ?が含まれる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db, 50, 0, { adminUserId: 'admin-1' });
    const logsSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const countSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(logsSql).toContain('admin_user_id = ?');
    expect(countSql).toContain('admin_user_id = ?');
  });

  it('adminUserIdフィルターをbindパラメータに含める', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db, 50, 0, { adminUserId: 'admin-xyz' });
    expect(logsStmt.bind).toHaveBeenCalledWith('admin-xyz', 50, 0);
    expect(countStmt.bind).toHaveBeenCalledWith('admin-xyz');
  });

  it('targetIdフィルターを指定するとSQLにtarget_id = ?が含まれる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db, 50, 0, { targetId: 'user-99' });
    const logsSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logsSql).toContain('target_id = ?');
    expect(logsStmt.bind).toHaveBeenCalledWith('user-99', 50, 0);
  });

  it('actionフィルターを指定するとSQLにaction = ?が含まれる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db, 50, 0, { action: 'user.delete' });
    const logsSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logsSql).toContain('action = ?');
    expect(logsStmt.bind).toHaveBeenCalledWith('user.delete', 50, 0);
  });

  it('複数フィルターを同時に指定できる', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db, 50, 0, {
      adminUserId: 'admin-1',
      targetId: 'user-1',
      action: 'role.change',
    });
    expect(logsStmt.bind).toHaveBeenCalledWith('admin-1', 'user-1', 'role.change', 50, 0);
    expect(countStmt.bind).toHaveBeenCalledWith('admin-1', 'user-1', 'role.change');
  });

  it('フィルターなしの場合はWHERE句を含まない', async () => {
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    await listAdminAuditLogs(db);
    const logsSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logsSql).not.toContain('WHERE');
  });

  it('複数のログを正しく返す', async () => {
    const mockLogs: AdminAuditLog[] = [
      { ...baseLog, id: 'log-2', created_at: '2024-02-01T00:00:00Z' },
      { ...baseLog, id: 'log-1', created_at: '2024-01-01T00:00:00Z' },
    ];
    const logsStmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockLogs }),
    };
    const countStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 2 }),
    };
    const db = {
      prepare: vi.fn().mockReturnValueOnce(logsStmt).mockReturnValueOnce(countStmt),
    } as unknown as D1Database;

    const result = await listAdminAuditLogs(db);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].id).toBe('log-2');
    expect(result.logs[1].id).toBe('log-1');
    expect(result.total).toBe(2);
  });
});
