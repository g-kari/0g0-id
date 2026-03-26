import { describe, it, expect, vi } from 'vitest';
import {
  updateUserRole,
  deleteUser,
  updateUserProfile,
  getUserProviders,
  unlinkProvider,
  linkProvider,
  upsertUser,
  upsertLineUser,
  upsertXUser,
  listUsers,
  countUsers,
  countAdminUsers,
  banUser,
  unbanUser,
} from './users';
import type { User } from '../types';
import { makeD1Mock } from './test-helpers';

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
  banned_at: null,
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
    const db = makeD1Mock(null, [], 1);
    const result = await deleteUser(db, 'user-1');
    expect(result).toBe(true);
  });

  it('対象ユーザーが存在しない場合はfalseを返す', async () => {
    const db = makeD1Mock(null, [], 0);
    const result = await deleteUser(db, 'not-exist');
    expect(result).toBe(false);
  });

  it('正しいSQLでDELETEを実行する', async () => {
    const db = makeD1Mock(null, [], 1);
    await deleteUser(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?');
  });
});

// 複数のprepare呼び出しを順番に異なる結果で返すモック
function makeMultiD1Mock(
  ...results: Array<{ first?: unknown; changes?: number; allResults?: unknown[] }>
): D1Database {
  let callIdx = 0;
  return {
    prepare: vi.fn().mockImplementation(() => {
      const r = results[callIdx++] ?? {};
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(r.first ?? null),
        run: vi.fn().mockResolvedValue({ meta: { changes: r.changes ?? 1 } }),
        all: vi.fn().mockResolvedValue({ results: r.allResults ?? [] }),
      };
    }),
  } as unknown as D1Database;
}

describe('getUserProviders', () => {
  const userWithGoogle: typeof baseUser = {
    ...baseUser,
    google_sub: 'google-sub-1',
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
  };

  it('全プロバイダーのステータスを返す', async () => {
    const db = makeD1Mock(userWithGoogle);
    const providers = await getUserProviders(db, 'user-1');
    expect(providers).toHaveLength(5);
    const names = providers.map((p) => p.provider);
    expect(names).toContain('google');
    expect(names).toContain('line');
    expect(names).toContain('twitch');
    expect(names).toContain('github');
    expect(names).toContain('x');
  });

  it('google_subが設定済みならconnected=trueを返す', async () => {
    const db = makeD1Mock(userWithGoogle);
    const providers = await getUserProviders(db, 'user-1');
    const google = providers.find((p) => p.provider === 'google');
    expect(google?.connected).toBe(true);
    const line = providers.find((p) => p.provider === 'line');
    expect(line?.connected).toBe(false);
  });

  it('ユーザーが存在しない場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(getUserProviders(db, 'not-exist')).rejects.toThrow('User not found');
  });
});

describe('unlinkProvider', () => {
  it('正常にプロバイダーの連携を解除できる', async () => {
    const db = makeD1Mock(null, [], 1);
    await expect(unlinkProvider(db, 'user-1', 'google')).resolves.toBeUndefined();
  });

  it('ユーザーが存在しない場合（0 changes）はエラーを投げる', async () => {
    const db = makeD1Mock(null, [], 0);
    await expect(unlinkProvider(db, 'not-exist', 'google')).rejects.toThrow('User not found');
  });

  it('対象プロバイダーのカラムをNULLに更新するSQLを実行する', async () => {
    const db = makeD1Mock(null, [], 1);
    await unlinkProvider(db, 'user-1', 'line');
    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('line_sub = NULL');
  });
});

describe('linkProvider', () => {
  const linkedUser = { ...baseUser, github_sub: 'github-sub-1' };

  it('新規リンクに成功する（既存サブIDなし）', async () => {
    // findByGithubSub → null, UPDATE → linkedUser
    const db = makeMultiD1Mock({ first: null }, { first: linkedUser });
    const user = await linkProvider(db, 'user-1', 'github', 'github-sub-1');
    expect(user.github_sub).toBe('github-sub-1');
  });

  it('同一ユーザーが再リンクする場合は成功する', async () => {
    // findBySub → same user (same id)
    const db = makeMultiD1Mock(
      { first: { ...baseUser, github_sub: 'github-sub-1' } },
      { first: linkedUser }
    );
    const user = await linkProvider(db, 'user-1', 'github', 'github-sub-1');
    expect(user).toBeDefined();
  });

  it('別ユーザーが同サブIDを使用している場合はPROVIDER_ALREADY_LINKEDをスロー', async () => {
    // findBySub → different user (different id)
    const otherUser = { ...baseUser, id: 'user-999', github_sub: 'github-sub-1' };
    const db = makeMultiD1Mock({ first: otherUser });
    await expect(linkProvider(db, 'user-1', 'github', 'github-sub-1')).rejects.toThrow(
      'PROVIDER_ALREADY_LINKED'
    );
  });

  it('ユーザーが見つからない場合（UPDATE返却null）はエラーを投げる', async () => {
    const db = makeMultiD1Mock({ first: null }, { first: null });
    await expect(linkProvider(db, 'user-1', 'google', 'google-sub-1')).rejects.toThrow(
      'User not found'
    );
  });
});

describe('upsertUser', () => {
  const googleUser = { ...baseUser, google_sub: 'google-sub-1' };

  it('既存Googleユーザーが見つかった場合はプロフィールを更新する', async () => {
    // findUserByGoogleSub → existing, UPDATE → updated
    const db = makeMultiD1Mock({ first: googleUser }, { first: googleUser });
    const user = await upsertUser(db, {
      id: 'user-new',
      googleSub: 'google-sub-1',
      email: 'test@example.com',
      emailVerified: true,
      name: 'Test User',
      picture: null,
    });
    expect(user.google_sub).toBe('google-sub-1');
  });

  it('google_sub未登録・同メールの既存ユーザーがいれば Google アカウントを連携する', async () => {
    // findUserByGoogleSub → null, findUserByEmail → existing, UPDATE → linked
    const emailUser = { ...baseUser, google_sub: null };
    const linked = { ...baseUser, google_sub: 'google-sub-new' };
    const db = makeMultiD1Mock({ first: null }, { first: emailUser }, { first: linked });
    const user = await upsertUser(db, {
      id: 'user-new',
      googleSub: 'google-sub-new',
      email: 'test@example.com',
      emailVerified: true,
      name: 'Test User',
      picture: null,
    });
    expect(user.google_sub).toBe('google-sub-new');
  });

  it('新規ユーザーを作成する', async () => {
    // findUserByGoogleSub → null, findUserByEmail → null, INSERT → new
    const db = makeMultiD1Mock({ first: null }, { first: null }, { first: googleUser });
    const user = await upsertUser(db, {
      id: 'user-1',
      googleSub: 'google-sub-1',
      email: 'test@example.com',
      emailVerified: true,
      name: 'Test User',
      picture: null,
    });
    expect(user.google_sub).toBe('google-sub-1');
    expect(user.email_verified).toBe(1);
  });

  it('DBがnullを返した場合はエラーを投げる（新規作成時）', async () => {
    const db = makeMultiD1Mock({ first: null }, { first: null }, { first: null });
    await expect(
      upsertUser(db, {
        id: 'user-1',
        googleSub: 'google-sub-1',
        email: 'test@example.com',
        emailVerified: true,
        name: 'Test User',
        picture: null,
      })
    ).rejects.toThrow('Failed to create Google user');
  });

  it('DBがnullを返した場合はエラーを投げる（連携時）', async () => {
    const emailUser = { ...baseUser, google_sub: null };
    const db = makeMultiD1Mock({ first: null }, { first: emailUser }, { first: null });
    await expect(
      upsertUser(db, {
        id: 'user-new',
        googleSub: 'google-sub-new',
        email: 'test@example.com',
        emailVerified: true,
        name: 'Test User',
        picture: null,
      })
    ).rejects.toThrow('Failed to link Google account');
  });
});

describe('upsertLineUser', () => {
  const lineUser = { ...baseUser, line_sub: 'line-sub-1', google_sub: null };

  it('既存LINEユーザーが見つかった場合はプロフィールを更新する', async () => {
    // findUserByLineSub → existing, UPDATE → updated
    const db = makeMultiD1Mock({ first: lineUser }, { first: lineUser });
    const user = await upsertLineUser(db, {
      id: 'user-new',
      lineSub: 'line-sub-1',
      email: 'line@example.com',
      isPlaceholderEmail: false,
      name: '更新名',
      picture: null,
    });
    expect(user.line_sub).toBe('line-sub-1');
  });

  it('仮メールでないユーザーのメール一致で既存アカウントにLINEを連携する', async () => {
    // findUserByLineSub → null, findUserByEmail → existing email user, UPDATE → linked
    const emailUser = { ...baseUser, line_sub: null };
    const db = makeMultiD1Mock(
      { first: null },
      { first: emailUser },
      { first: { ...emailUser, line_sub: 'line-sub-1' } }
    );
    const user = await upsertLineUser(db, {
      id: 'user-new',
      lineSub: 'line-sub-1',
      email: 'test@example.com',
      isPlaceholderEmail: false,
      name: 'Test User',
      picture: null,
    });
    expect(user.line_sub).toBe('line-sub-1');
  });

  it('仮メールの新規ユーザーを作成する', async () => {
    // findUserByLineSub → null, INSERT → newUser
    const newUser = { ...baseUser, line_sub: 'line-sub-new', google_sub: null };
    const db = makeMultiD1Mock({ first: null }, { first: newUser });
    const user = await upsertLineUser(db, {
      id: 'user-new',
      lineSub: 'line-sub-new',
      email: 'line_placeholder@line.placeholder',
      isPlaceholderEmail: true,
      name: 'LINE User',
      picture: null,
    });
    expect(user.line_sub).toBe('line-sub-new');
  });

  it('DBがnullを返した場合はエラーを投げる（既存ユーザー更新時）', async () => {
    const db = makeMultiD1Mock({ first: lineUser }, { first: null });
    await expect(
      upsertLineUser(db, {
        id: 'user-new',
        lineSub: 'line-sub-1',
        email: 'line@example.com',
        isPlaceholderEmail: false,
        name: 'Name',
        picture: null,
      })
    ).rejects.toThrow('Failed to update LINE user');
  });
});

describe('upsertXUser', () => {
  const xUser = { ...baseUser, x_sub: 'x-sub-1', google_sub: null };

  it('既存Xユーザーが見つかった場合はプロフィールを更新する', async () => {
    // findUserByXSub → existing, UPDATE → updated
    const db = makeMultiD1Mock({ first: xUser }, { first: xUser });
    const user = await upsertXUser(db, {
      id: 'user-new',
      xSub: 'x-sub-1',
      email: 'x_1@x.placeholder',
      name: 'X User',
      picture: null,
    });
    expect(user.x_sub).toBe('x-sub-1');
  });

  it('新規Xユーザーを作成する', async () => {
    // findUserByXSub → null, INSERT → newUser
    const db = makeMultiD1Mock({ first: null }, { first: xUser });
    const user = await upsertXUser(db, {
      id: 'user-new',
      xSub: 'x-sub-1',
      email: 'x_1@x.placeholder',
      name: 'New X User',
      picture: 'https://example.com/avatar.jpg',
    });
    expect(user.x_sub).toBe('x-sub-1');
  });

  it('DBがnullを返した場合はエラーを投げる（新規作成時）', async () => {
    const db = makeMultiD1Mock({ first: null }, { first: null });
    await expect(
      upsertXUser(db, {
        id: 'user-new',
        xSub: 'x-sub-new',
        email: 'x_new@x.placeholder',
        name: 'Name',
        picture: null,
      })
    ).rejects.toThrow('Failed to create X user');
  });
});

describe('listUsers', () => {
  it('ユーザー一覧を返す', async () => {
    const db = makeD1Mock(null);
    // all()の結果をモックに含める
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [baseUser] }) };
    const db2 = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const users = await listUsers(db2, 10, 0);
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('user-1');
  });

  it('デフォルトのlimit/offsetで呼び出せる', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const users = await listUsers(db);
    expect(users).toEqual([]);
    expect(stmt.bind).toHaveBeenCalledWith(50, 0);
  });

  it('emailフィルターでLIKE検索を行う', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [baseUser] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { email: 'example' });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE email LIKE ?'));
    expect(stmt.bind).toHaveBeenCalledWith('%example%', 10, 0);
  });

  it('roleフィルターで完全一致検索を行う', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { role: 'admin' });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE role = ?'));
    expect(stmt.bind).toHaveBeenCalledWith('admin', 10, 0);
  });

  it('nameフィルターでLIKE検索を行う', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { name: 'Test' });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE name LIKE ?'));
    expect(stmt.bind).toHaveBeenCalledWith('%Test%', 10, 0);
  });

  it('複数フィルターをANDで結合する', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { email: 'example', role: 'admin' });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('email LIKE ?');
    expect(sql).toContain('role = ?');
    expect(sql).toContain('AND');
    expect(stmt.bind).toHaveBeenCalledWith('%example%', 'admin', 10, 0);
  });

  it('フィルターなしの場合はWHER句を含まない', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, {});
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).not.toContain('WHERE');
  });

  it('banned=trueフィルターでBAN済みユーザーのみ検索する', async () => {
    const bannedUser = { ...baseUser, banned_at: '2026-03-24T00:00:00Z' };
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [bannedUser] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { banned: true });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('banned_at IS NOT NULL');
    expect(stmt.bind).toHaveBeenCalledWith(10, 0);
  });

  it('banned=falseフィルターでBAN済みを除外して検索する', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [baseUser] }) };
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await listUsers(db, 10, 0, { banned: false });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('banned_at IS NULL');
    expect(stmt.bind).toHaveBeenCalledWith(10, 0);
  });
});

describe('countUsers', () => {
  it('ユーザー総数を返す', async () => {
    const db = makeD1Mock({ count: 42 });
    const count = await countUsers(db);
    expect(count).toBe(42);
  });

  it('DBがnullを返した場合は0を返す', async () => {
    const db = makeD1Mock(null);
    const count = await countUsers(db);
    expect(count).toBe(0);
  });

  it('emailフィルターで絞り込み件数を返す', async () => {
    const db = makeD1Mock({ count: 5 });
    const count = await countUsers(db, { email: 'example' });
    expect(count).toBe(5);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith('%example%');
  });

  it('roleフィルターで絞り込み件数を返す', async () => {
    const db = makeD1Mock({ count: 3 });
    const count = await countUsers(db, { role: 'admin' });
    expect(count).toBe(3);
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith('admin');
  });

  it('フィルターなしの場合はWHER句を含まない', async () => {
    const db = makeD1Mock({ count: 10 });
    await countUsers(db, {});
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).not.toContain('WHERE');
  });

  it('banned=trueフィルターでBAN済みユーザー数を返す', async () => {
    const db = makeD1Mock({ count: 3 });
    const count = await countUsers(db, { banned: true });
    expect(count).toBe(3);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('banned_at IS NOT NULL');
  });

  it('banned=falseフィルターでBAN済み除外の件数を返す', async () => {
    const db = makeD1Mock({ count: 97 });
    const count = await countUsers(db, { banned: false });
    expect(count).toBe(97);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('banned_at IS NULL');
  });
});

describe('countAdminUsers', () => {
  it('管理者数を返す', async () => {
    const db = makeD1Mock({ count: 2 });
    const count = await countAdminUsers(db);
    expect(count).toBe(2);
  });

  it('DBがnullを返した場合は0を返す', async () => {
    const db = makeD1Mock(null);
    const count = await countAdminUsers(db);
    expect(count).toBe(0);
  });
});

describe('banUser', () => {
  it('banned_atが設定されたユーザーを返す', async () => {
    const bannedUser = { ...baseUser, banned_at: '2026-03-24T00:00:00Z' };
    const db = makeD1Mock(bannedUser);
    const user = await banUser(db, 'user-1');
    expect(user.banned_at).toBe('2026-03-24T00:00:00Z');
    expect(user.id).toBe('user-1');
  });

  it('ユーザーが見つからない場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(banUser(db, 'not-exist')).rejects.toThrow('User not found');
  });

  it('正しいSQLパラメーターでprepareを呼ぶ', async () => {
    const bannedUser = { ...baseUser, banned_at: '2026-03-24T00:00:00Z' };
    const db = makeD1Mock(bannedUser);
    await banUser(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("banned_at = datetime('now')")
    );
  });
});

describe('unbanUser', () => {
  it('banned_atがnullになったユーザーを返す', async () => {
    const db = makeD1Mock(baseUser);
    const user = await unbanUser(db, 'user-1');
    expect(user.banned_at).toBeNull();
    expect(user.id).toBe('user-1');
  });

  it('ユーザーが見つからない場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(unbanUser(db, 'not-exist')).rejects.toThrow('User not found');
  });

  it('banned_at = NULL を設定するSQLを呼ぶ', async () => {
    const db = makeD1Mock(baseUser);
    await unbanUser(db, 'user-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('banned_at = NULL')
    );
  });
});
