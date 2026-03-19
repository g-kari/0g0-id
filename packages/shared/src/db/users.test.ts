import { describe, it, expect, vi } from 'vitest';
import { updateUserRole, deleteUser, updateUserProfile } from './users';
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
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
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

describe('updateUserProfile', () => {
  it('名前のみ更新できる', async () => {
    const updated = { ...baseUser, name: '新しい名前' };
    const db = makeD1Mock(updated);
    const user = await updateUserProfile(db, 'user-1', { name: '新しい名前' });
    expect(user.name).toBe('新しい名前');
  });

  it('picture を更新できる', async () => {
    const updated = { ...baseUser, picture: 'https://example.com/avatar.jpg' };
    const db = makeD1Mock(updated);
    const user = await updateUserProfile(db, 'user-1', {
      name: 'Test User',
      picture: 'https://example.com/avatar.jpg',
    });
    expect(user.picture).toBe('https://example.com/avatar.jpg');
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('picture = ?');
    expect(stmt.bind).toHaveBeenCalledWith('Test User', 'https://example.com/avatar.jpg', 'user-1');
  });

  it('picture を null にクリアできる', async () => {
    const updated = { ...baseUser, picture: null };
    const db = makeD1Mock(updated);
    const user = await updateUserProfile(db, 'user-1', { name: 'Test User', picture: null });
    expect(user.picture).toBeNull();
  });

  it('名前・picture・phone・address を同時に更新できる', async () => {
    const updated = {
      ...baseUser,
      name: '更新名',
      picture: 'https://img.example.com/a.png',
      phone: '090-0000-0000',
      address: '東京都',
    };
    const db = makeD1Mock(updated);
    const user = await updateUserProfile(db, 'user-1', {
      name: '更新名',
      picture: 'https://img.example.com/a.png',
      phone: '090-0000-0000',
      address: '東京都',
    });
    expect(user.name).toBe('更新名');
    expect(user.picture).toBe('https://img.example.com/a.png');
    expect(user.phone).toBe('090-0000-0000');
    expect(user.address).toBe('東京都');
  });

  it('ユーザーが見つからない場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(updateUserProfile(db, 'not-exist', { name: 'Name' })).rejects.toThrow(
      'User not found'
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
