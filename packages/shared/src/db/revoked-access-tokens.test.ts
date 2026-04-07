import { describe, it, expect, vi } from 'vitest';
import {
  addRevokedAccessToken,
  isAccessTokenRevoked,
  cleanupExpiredRevokedAccessTokens,
} from './revoked-access-tokens';
import { makeD1Mock } from './test-helpers';

describe('addRevokedAccessToken', () => {
  it('INSERT OR IGNORE 文を正しいパラメーターで実行する', async () => {
    const db = makeD1Mock(null);
    await addRevokedAccessToken(db, 'jti-abc', 9999999999);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO revoked_access_tokens')
    );
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith('jti-abc', 9999999999);
    expect(stmt.run).toHaveBeenCalled();
  });

  it('void を返す（戻り値なし）', async () => {
    const db = makeD1Mock(null);
    const result = await addRevokedAccessToken(db, 'jti-xyz', 1234567890);
    expect(result).toBeUndefined();
  });

  it('同一JTIの二重登録は INSERT OR IGNORE で無視される（冪等性）', async () => {
    const db = makeD1Mock(null, [], 0);
    // changes=0 でも例外を投げない
    await expect(addRevokedAccessToken(db, 'jti-dup', 9999999999)).resolves.toBeUndefined();
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });
});

describe('isAccessTokenRevoked', () => {
  it('JTIがブロックリストに存在する場合 true を返す', async () => {
    const db = makeD1Mock({ '1': 1 }); // first() が非nullを返す
    const result = await isAccessTokenRevoked(db, 'jti-revoked');
    expect(result).toBe(true);
  });

  it('JTIがブロックリストに存在しない（または期限切れ）場合 false を返す', async () => {
    const db = makeD1Mock(null);
    const result = await isAccessTokenRevoked(db, 'jti-not-found');
    expect(result).toBe(false);
  });

  it('JTIと expires_at > unixepoch() の両方で絞り込む SQL を使う', async () => {
    const db = makeD1Mock(null);
    await isAccessTokenRevoked(db, 'jti-check');

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('jti = ?')
    );
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('unixepoch()')
    );
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith('jti-check');
    expect(stmt.first).toHaveBeenCalled();
  });

  it('期限切れJTIは除外される（DB側フィルタリングを確認）', async () => {
    // 期限切れレコードは WHERE expires_at > unixepoch() でDBが除外し、first() は null を返す
    const db = makeD1Mock(null);
    const result = await isAccessTokenRevoked(db, 'jti-expired');
    expect(result).toBe(false);
  });
});

describe('cleanupExpiredRevokedAccessTokens', () => {
  it('期限切れエントリを削除して件数を返す', async () => {
    const db = makeD1Mock(null, [], 5);
    const count = await cleanupExpiredRevokedAccessTokens(db);
    expect(count).toBe(5);
  });

  it('削除対象がない場合は 0 を返す', async () => {
    const db = makeD1Mock(null, [], 0);
    const count = await cleanupExpiredRevokedAccessTokens(db);
    expect(count).toBe(0);
  });

  it('DELETE 文に unixepoch() による期限切れフィルタを使う', async () => {
    const db = makeD1Mock(null, [], 2);
    await cleanupExpiredRevokedAccessTokens(db);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM revoked_access_tokens')
    );
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('unixepoch()')
    );
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.run).toHaveBeenCalled();
  });

  it('meta.changes が undefined の場合は 0 を返す', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ meta: {} }), // changes 未定義
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    const db = { prepare: vi.fn().mockReturnValue(stmt), _stmt: stmt } as unknown as D1Database & { _stmt: typeof stmt };
    const count = await cleanupExpiredRevokedAccessTokens(db);
    expect(count).toBe(0);
  });
});
