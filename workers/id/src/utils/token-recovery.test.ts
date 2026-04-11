import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  unrevokeRefreshToken: vi.fn(),
  findRefreshTokenById: vi.fn(),
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import { unrevokeRefreshToken, findRefreshTokenById } from '@0g0-id/shared';
import { attemptUnrevokeToken } from './token-recovery';
import type { RefreshToken } from '@0g0-id/shared';

const mockDb = {} as D1Database;

function makeToken(revoked_reason: string | null): RefreshToken {
  return {
    id: 'token-1',
    user_id: 'user-1',
    service_id: null,
    token_hash: 'hash',
    family_id: 'family-1',
    revoked_at: revoked_reason ? '2024-01-01T00:00:00Z' : null,
    revoked_reason,
    scope: null,
    pairwise_sub: null,
    expires_at: '2024-01-31T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
  };
}

describe('attemptUnrevokeToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revoked_reason が reuse_detected の場合は unrevokeRefreshToken を呼ばない', async () => {
    vi.mocked(findRefreshTokenById).mockResolvedValue(makeToken('reuse_detected'));
    await attemptUnrevokeToken(mockDb, 'token-1', '[test]');
    expect(unrevokeRefreshToken).not.toHaveBeenCalled();
  });

  it('トークンが null の場合は unrevokeRefreshToken を呼ぶ', async () => {
    vi.mocked(findRefreshTokenById).mockResolvedValue(null);
    vi.mocked(unrevokeRefreshToken).mockResolvedValue(true);
    await attemptUnrevokeToken(mockDb, 'token-1', '[test]');
    expect(unrevokeRefreshToken).toHaveBeenCalledWith(mockDb, 'token-1');
  });

  it('revoked_reason が rotation の場合は unrevokeRefreshToken を呼ぶ', async () => {
    vi.mocked(findRefreshTokenById).mockResolvedValue(makeToken('rotation'));
    vi.mocked(unrevokeRefreshToken).mockResolvedValue(true);
    await attemptUnrevokeToken(mockDb, 'token-1', '[test]');
    expect(unrevokeRefreshToken).toHaveBeenCalledWith(mockDb, 'token-1');
  });

  it('unrevokeRefreshToken が false を返しても例外なく完了する', async () => {
    vi.mocked(findRefreshTokenById).mockResolvedValue(makeToken('rotation'));
    vi.mocked(unrevokeRefreshToken).mockResolvedValue(false);
    await expect(attemptUnrevokeToken(mockDb, 'token-1', '[test]')).resolves.toBeUndefined();
  });

  it('findRefreshTokenById が例外を投げても reject せず resolve する', async () => {
    vi.mocked(findRefreshTokenById).mockRejectedValue(new Error('DB error'));
    await expect(attemptUnrevokeToken(mockDb, 'token-1', '[test]')).resolves.toBeUndefined();
    expect(unrevokeRefreshToken).not.toHaveBeenCalled();
  });

  it('unrevokeRefreshToken が例外を投げても reject せず resolve する', async () => {
    vi.mocked(findRefreshTokenById).mockResolvedValue(makeToken('rotation'));
    vi.mocked(unrevokeRefreshToken).mockRejectedValue(new Error('unrevoke failed'));
    await expect(attemptUnrevokeToken(mockDb, 'token-1', '[test]')).resolves.toBeUndefined();
  });
});
