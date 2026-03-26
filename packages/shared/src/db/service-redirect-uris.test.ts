import { describe, it, expect, vi } from 'vitest';
import {
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  isValidRedirectUri,
} from './service-redirect-uris';
import type { ServiceRedirectUri } from '../types';
import { makeD1Mock } from './test-helpers';

const baseUri: ServiceRedirectUri = {
  id: 'uri-1',
  service_id: 'service-1',
  uri: 'https://example.com/callback',
  created_at: '2024-01-01T00:00:00Z',
};

describe('listRedirectUris', () => {
  it('リダイレクトURI一覧を返す', async () => {
    const db = makeD1Mock(null, [baseUri]);
    const result = await listRedirectUris(db, 'service-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseUri);
  });

  it('URIがない場合は空配列を返す', async () => {
    const db = makeD1Mock(null, []);
    const result = await listRedirectUris(db, 'service-1');
    expect(result).toEqual([]);
  });

  it('service_idでフィルタリングするSQLを使用する', async () => {
    const db = makeD1Mock(null, []);
    await listRedirectUris(db, 'service-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE service_id = ?')
    );
  });

  it('ORDER BY created_at ASCでソートする', async () => {
    const db = makeD1Mock(null, []);
    await listRedirectUris(db, 'service-1');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at ASC')
    );
  });
});

describe('addRedirectUri', () => {
  it('リダイレクトURIを追加してServiceRedirectUriを返す', async () => {
    const db = makeD1Mock(baseUri);
    const result = await addRedirectUri(db, {
      id: 'uri-1',
      serviceId: 'service-1',
      uri: 'https://example.com/callback',
    });
    expect(result).toEqual(baseUri);
  });

  it('DBがnullを返した場合はエラーを投げる', async () => {
    const db = makeD1Mock(null);
    await expect(
      addRedirectUri(db, {
        id: 'uri-1',
        serviceId: 'service-1',
        uri: 'https://example.com/callback',
      })
    ).rejects.toThrow('Failed to add redirect URI');
  });

  it('INSERTのSQLを使用する', async () => {
    const db = makeD1Mock(baseUri);
    await addRedirectUri(db, {
      id: 'uri-1',
      serviceId: 'service-1',
      uri: 'https://example.com/callback',
    });
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO service_redirect_uris')
    );
  });
});

describe('deleteRedirectUri', () => {
  it('指定したidとservice_idでDELETEを実行する', async () => {
    const db = makeD1Mock(null, [], 1);
    await deleteRedirectUri(db, 'uri-1', 'service-1');
    expect(db.prepare).toHaveBeenCalledWith(
      'DELETE FROM service_redirect_uris WHERE id = ? AND service_id = ?'
    );
    expect(db._stmt.bind).toHaveBeenCalledWith('uri-1', 'service-1');
  });

  it('削除対象が存在しない場合も正常終了する（changes=0）', async () => {
    const db = makeD1Mock(null, [], 0);
    await expect(deleteRedirectUri(db, 'non-existent', 'service-1')).resolves.toBeUndefined();
  });
});

describe('isValidRedirectUri', () => {
  it('有効なURIが存在する場合はtrueを返す', async () => {
    const db = makeD1Mock({ id: 'uri-1' });
    const result = await isValidRedirectUri(db, 'service-1', 'https://example.com/callback');
    expect(result).toBe(true);
  });

  it('URIが存在しない場合はfalseを返す', async () => {
    const db = makeD1Mock(null);
    const result = await isValidRedirectUri(db, 'service-1', 'https://unknown.com/callback');
    expect(result).toBe(false);
  });

  it('service_idとuriでフィルタリングするSQLを使用する', async () => {
    const db = makeD1Mock(null);
    await isValidRedirectUri(db, 'service-1', 'https://example.com/callback');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE service_id = ? AND uri = ?')
    );
  });
});
