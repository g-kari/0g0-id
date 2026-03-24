import { describe, it, expect, vi } from 'vitest';
import {
  findServiceById,
  findServiceByClientId,
  createService,
  deleteService,
  listServices,
  countServicesByOwner,
  countServices,
} from './services';
import type { Service } from '../types';

function makeD1Mock(
  firstResult: unknown = null,
  allResults: unknown[] = [],
  changes = 1
): D1Database & { _stmt: ReturnType<typeof vi.fn> } {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    all: vi.fn().mockResolvedValue({ results: allResults }),
  };
  const db = { prepare: vi.fn().mockReturnValue(stmt), _stmt: stmt };
  return db as unknown as D1Database & { _stmt: ReturnType<typeof vi.fn> };
}

const baseService: Service = {
  id: 'service-1',
  name: 'テストサービス',
  client_id: 'client_abc123',
  client_secret_hash: 'hash_xyz',
  allowed_scopes: '["profile","email"]',
  owner_user_id: 'user-1',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('findServiceById', () => {
  it('サービスが存在する場合はServiceを返す', async () => {
    const db = makeD1Mock(baseService);
    const result = await findServiceById(db, 'service-1');
    expect(result).toEqual(baseService);
  });

  it('サービスが存在しない場合はnullを返す', async () => {
    const db = makeD1Mock(null);
    const result = await findServiceById(db, 'not-exist');
    expect(result).toBeNull();
  });

  it('正しいSQLでprepareを呼ぶ', async () => {
    const db = makeD1Mock(baseService);
    await findServiceById(db, 'service-1');
    expect(db.prepare).toHaveBeenCalledWith('SELECT * FROM services WHERE id = ?');
  });
});

describe('findServiceByClientId', () => {
  it('client_idでサービスを取得できる', async () => {
    const db = makeD1Mock(baseService);
    const result = await findServiceByClientId(db, 'client_abc123');
    expect(result).toEqual(baseService);
  });

  it('存在しないclient_idはnullを返す', async () => {
    const db = makeD1Mock(null);
    const result = await findServiceByClientId(db, 'not-exist');
    expect(result).toBeNull();
  });
});

describe('createService', () => {
  it('サービスを作成してServiceを返す', async () => {
    const db = makeD1Mock(baseService);
    const result = await createService(db, {
      id: 'service-1',
      name: 'テストサービス',
      clientId: 'client_abc123',
      clientSecretHash: 'hash_xyz',
      allowedScopes: '["profile","email"]',
      ownerUserId: 'user-1',
    });
    expect(result).toEqual(baseService);
  });

  it('DBがnullを返した場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(
      createService(db, {
        id: 'service-1',
        name: 'テストサービス',
        clientId: 'client_abc123',
        clientSecretHash: 'hash_xyz',
        allowedScopes: '["profile","email"]',
        ownerUserId: 'user-1',
      })
    ).rejects.toThrow('Failed to create service');
  });

  it('INSERTのSQLを使用する', async () => {
    const db = makeD1Mock(baseService);
    await createService(db, {
      id: 'service-1',
      name: 'テストサービス',
      clientId: 'client_abc123',
      clientSecretHash: 'hash_xyz',
      allowedScopes: '["profile","email"]',
      ownerUserId: 'user-1',
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO services'));
  });
});

describe('deleteService', () => {
  it('削除クエリを実行する', async () => {
    const db = makeD1Mock(null, [], 1);
    await deleteService(db, 'service-1');
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM services WHERE id = ?');
    expect(db._stmt.bind).toHaveBeenCalledWith('service-1');
  });
});

describe('listServices', () => {
  it('サービス一覧を返す', async () => {
    const db = makeD1Mock(null, [baseService]);
    const result = await listServices(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseService);
  });

  it('サービスがない場合は空配列を返す', async () => {
    const db = makeD1Mock(null, []);
    const result = await listServices(db);
    expect(result).toEqual([]);
  });

  it('ORDER BY created_at DESCでソートする', async () => {
    const db = makeD1Mock(null, []);
    await listServices(db);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at DESC')
    );
  });

  it('nameフィルターでWHERE句を生成する', async () => {
    const db = makeD1Mock(null, [baseService]);
    await listServices(db, { name: 'テスト' });
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE name LIKE ?')
    );
    expect(db._stmt.bind).toHaveBeenCalledWith('%テスト%', 50, 0);
  });

  it('limitとoffsetをSQLに渡す', async () => {
    const db = makeD1Mock(null, [baseService]);
    await listServices(db, { limit: 10, offset: 20 });
    expect(db._stmt.bind).toHaveBeenCalledWith(10, 20);
  });

  it('nameなしの場合はWHERE句なしでクエリを実行する', async () => {
    const db = makeD1Mock(null, []);
    await listServices(db, { limit: 10, offset: 0 });
    const calledSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledSql).not.toContain('WHERE');
    expect(db._stmt.bind).toHaveBeenCalledWith(10, 0);
  });
});

describe('countServicesByOwner', () => {
  it('オーナーのサービス数を返す', async () => {
    const db = makeD1Mock({ count: 3 });
    const result = await countServicesByOwner(db, 'user-1');
    expect(result).toBe(3);
  });

  it('DBがnullを返した場合は0を返す', async () => {
    const db = makeD1Mock(null);
    const result = await countServicesByOwner(db, 'user-1');
    expect(result).toBe(0);
  });
});

describe('countServices', () => {
  it('全サービス数を返す', async () => {
    const db = makeD1Mock({ count: 10 });
    const result = await countServices(db);
    expect(result).toBe(10);
  });

  it('DBがnullを返した場合は0を返す', async () => {
    const db = makeD1Mock(null);
    const result = await countServices(db);
    expect(result).toBe(0);
  });

  it('nameフィルターでWHERE句を生成する', async () => {
    const db = makeD1Mock({ count: 5 });
    await countServices(db, { name: 'テスト' });
    const calledSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledSql).toContain('WHERE name LIKE ?');
    expect(db._stmt.bind).toHaveBeenCalledWith('%テスト%');
  });

  it('nameなしの場合はWHERE句なしでクエリを実行する', async () => {
    const db = makeD1Mock({ count: 3 });
    await countServices(db, {});
    const calledSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledSql).not.toContain('WHERE');
  });
});
