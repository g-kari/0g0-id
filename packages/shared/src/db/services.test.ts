import { describe, it, expect, vi } from 'vitest';
import {
  findServiceById,
  findServiceByClientId,
  createService,
  deleteService,
  listServices,
  listServicesByOwner,
  countServicesByOwner,
  countServices,
  updateServiceFields,
  rotateClientSecret,
  transferServiceOwnership,
} from './services';
import type { Service } from '../types';
import { makeD1Mock } from './test-helpers';

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

describe('listServicesByOwner', () => {
  it('オーナーのサービス一覧を返す', async () => {
    const db = makeD1Mock(null, [baseService]);
    const result = await listServicesByOwner(db, 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseService);
  });

  it('サービスがない場合は空配列を返す', async () => {
    const db = makeD1Mock(null, []);
    const result = await listServicesByOwner(db, 'user-1');
    expect(result).toEqual([]);
  });

  it('owner_user_id = ? のSQLを呼ぶ', async () => {
    const db = makeD1Mock(null, []);
    await listServicesByOwner(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE owner_user_id = ?')
    );
    expect(db._stmt.bind).toHaveBeenCalledWith('user-1');
  });

  it('ORDER BY created_at DESCでソートする', async () => {
    const db = makeD1Mock(null, []);
    await listServicesByOwner(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at DESC')
    );
  });
});

describe('updateServiceFields', () => {
  it('nameのみ更新する', async () => {
    const updated = { ...baseService, name: '新しい名前' };
    const db = makeD1Mock(updated);
    const result = await updateServiceFields(db, 'service-1', { name: '新しい名前' });
    expect(result).toEqual(updated);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('name = ?'));
    expect(db._stmt.bind).toHaveBeenCalledWith('新しい名前', 'service-1');
  });

  it('allowedScopesのみ更新する', async () => {
    const updated = { ...baseService, allowed_scopes: '["openid"]' };
    const db = makeD1Mock(updated);
    const result = await updateServiceFields(db, 'service-1', { allowedScopes: '["openid"]' });
    expect(result).toEqual(updated);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('allowed_scopes = ?'));
    expect(db._stmt.bind).toHaveBeenCalledWith('["openid"]', 'service-1');
  });

  it('nameとallowedScopesを同時に更新する', async () => {
    const updated = { ...baseService, name: '新しい名前', allowed_scopes: '["openid"]' };
    const db = makeD1Mock(updated);
    const result = await updateServiceFields(db, 'service-1', {
      name: '新しい名前',
      allowedScopes: '["openid"]',
    });
    expect(result).toEqual(updated);
    const calledSql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledSql).toContain('name = ?');
    expect(calledSql).toContain('allowed_scopes = ?');
    expect(db._stmt.bind).toHaveBeenCalledWith('新しい名前', '["openid"]', 'service-1');
  });

  it('fieldsが空の場合はnullを返す（DBを呼ばない）', async () => {
    const db = makeD1Mock(baseService);
    const result = await updateServiceFields(db, 'service-1', {});
    expect(result).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('サービスが存在しない場合はnullを返す', async () => {
    const db = makeD1Mock(null);
    const result = await updateServiceFields(db, 'not-exist', { name: '新しい名前' });
    expect(result).toBeNull();
  });
});

describe('rotateClientSecret', () => {
  it('新しいclient_secret_hashでUPDATEする', async () => {
    const updated = { ...baseService, client_secret_hash: 'new_hash' };
    const db = makeD1Mock(updated);
    const result = await rotateClientSecret(db, 'service-1', 'new_hash');
    expect(result).toEqual(updated);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('client_secret_hash = ?')
    );
    expect(db._stmt.bind).toHaveBeenCalledWith('new_hash', 'service-1');
  });

  it('サービスが存在しない場合はnullを返す', async () => {
    const db = makeD1Mock(null);
    const result = await rotateClientSecret(db, 'not-exist', 'new_hash');
    expect(result).toBeNull();
  });

  it('RETURNING *でサービスを返す', async () => {
    const db = makeD1Mock(baseService);
    await rotateClientSecret(db, 'service-1', 'new_hash');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('RETURNING *'));
  });
});

describe('transferServiceOwnership', () => {
  it('新しいowner_user_idでUPDATEする', async () => {
    const updated = { ...baseService, owner_user_id: 'user-2' };
    const db = makeD1Mock(updated);
    const result = await transferServiceOwnership(db, 'service-1', 'user-2');
    expect(result).toEqual(updated);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('owner_user_id = ?')
    );
    expect(db._stmt.bind).toHaveBeenCalledWith('user-2', 'service-1');
  });

  it('サービスが存在しない場合はnullを返す', async () => {
    const db = makeD1Mock(null);
    const result = await transferServiceOwnership(db, 'not-exist', 'user-2');
    expect(result).toBeNull();
  });

  it('RETURNING *でサービスを返す', async () => {
    const db = makeD1Mock(baseService);
    await transferServiceOwnership(db, 'service-1', 'user-2');
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('RETURNING *'));
  });
});
