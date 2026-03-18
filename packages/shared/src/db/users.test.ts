import { describe, it, expect, vi } from 'vitest';
import { updateUserRole, deleteUser } from './users';
import type { User } from '../types';

// D1Database のモック
function makeD1Mock(firstResult: unknown, changes = 1): D1Database {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
}

const baseUser: User = {
  id: 'user-1',
  google_sub: 'google-sub-1',
  email: 'test@example.com',
  email_verified: 1,
  name: 'Test User',
  picture: null,
  phone: null,
  address: null,
  role: 'admin',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('updateUserRole', () => {
  it('ロールを変更したユーザーを返す', async () => {
    const db = makeD1Mock(baseUser);
    const user = await updateUserRole(db, 'user-1', 'admin');
    expect(user.role).toBe('admin');
    expect(user.id).toBe('user-1');
  });

  it('ユーザーが見つからない場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(updateUserRole(db, 'not-exist', 'admin')).rejects.toThrow('User not found');
  });

  it('正しいSQLパラメーターでprepareを呼ぶ', async () => {
    const db = makeD1Mock(baseUser);
    await updateUserRole(db, 'user-1', 'admin');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET role')
    );
  });
});

describe('deleteUser', () => {
  it('削除成功時にtrueを返す', async () => {
    const db = makeD1Mock(null, 1);
    const result = await deleteUser(db, 'user-1');
    expect(result).toBe(true);
  });

  it('対象ユーザーが存在しない場合はfalseを返す', async () => {
    const db = makeD1Mock(null, 0);
    const result = await deleteUser(db, 'not-exist');
    expect(result).toBe(false);
  });

  it('正しいSQLでDELETEを実行する', async () => {
    const db = makeD1Mock(null, 1);
    await deleteUser(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?');
  });
});
