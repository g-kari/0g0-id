import { describe, it, expect, vi } from 'vitest';
import { createAuthCode, findAndConsumeAuthCode } from './auth-codes';
import type { AuthCode } from '../types';

function makeD1Mock(firstResult: unknown, changes = 1): D1Database {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
}

const baseAuthCode: AuthCode = {
  id: 'code-id-1',
  user_id: 'user-1',
  service_id: null,
  code_hash: 'hash-abc123',
  redirect_to: 'https://user.0g0.xyz/callback',
  expires_at: '2024-12-31T23:59:59Z',
  used_at: null,
  created_at: '2024-01-01T00:00:00Z',
  nonce: null,
  code_challenge: null,
  code_challenge_method: null,
  scope: null,
};

describe('createAuthCode', () => {
  it('正しいパラメーターでINSERT文を実行する', async () => {
    const db = makeD1Mock(null);
    await createAuthCode(db, {
      id: 'code-id-1',
      userId: 'user-1',
      codeHash: 'hash-abc123',
      redirectTo: 'https://user.0g0.xyz/callback',
      expiresAt: '2024-12-31T23:59:59Z',
    });

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO auth_codes')
    );
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith(
      'code-id-1',
      'user-1',
      null,
      'hash-abc123',
      'https://user.0g0.xyz/callback',
      '2024-12-31T23:59:59Z',
      null,
      null,
      null,
      null
    );
    expect(stmt.run).toHaveBeenCalled();
  });

  it('runが呼ばれてもvoidを返す（戻り値なし）', async () => {
    const db = makeD1Mock(null);
    const result = await createAuthCode(db, {
      id: 'code-id-2',
      userId: 'user-2',
      codeHash: 'hash-xyz',
      redirectTo: 'https://example.com/cb',
      expiresAt: '2025-01-01T00:00:00Z',
    });
    expect(result).toBeUndefined();
  });
});

describe('findAndConsumeAuthCode', () => {
  it('有効なcodeHashに対してAuthCodeを返す', async () => {
    const db = makeD1Mock(baseAuthCode);
    const result = await findAndConsumeAuthCode(db, 'hash-abc123');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('code-id-1');
    expect(result?.user_id).toBe('user-1');
    expect(result?.redirect_to).toBe('https://user.0g0.xyz/callback');
  });

  it('codeが存在しない・期限切れ・使用済みの場合は null を返す', async () => {
    const db = makeD1Mock(null);
    const result = await findAndConsumeAuthCode(db, 'invalid-hash');
    expect(result).toBeNull();
  });

  it('UPDATEとRETURNINGを含むSQL文を使う', async () => {
    const db = makeD1Mock(baseAuthCode);
    await findAndConsumeAuthCode(db, 'hash-abc123');

    const sql: string = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain('UPDATE auth_codes');
    expect(sql).toContain('used_at');
    expect(sql).toContain('RETURNING');
  });

  it('指定したcodeHashでbindを呼ぶ', async () => {
    const db = makeD1Mock(baseAuthCode);
    await findAndConsumeAuthCode(db, 'hash-abc123');

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith('hash-abc123');
  });
});
