import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createLogger でロガーインスタンスを生成できる', () => {
    const logger = createLogger('test');
    expect(logger).toHaveProperty('debug');
    expect(logger).toHaveProperty('info');
    expect(logger).toHaveProperty('warn');
    expect(logger).toHaveProperty('error');
  });

  it('info ログが console.log に JSON 形式で出力される', () => {
    const logger = createLogger('auth');
    logger.info('ログインしました');
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('info');
    expect(output.ctx).toBe('auth');
    expect(output.msg).toBe('ログインしました');
  });

  it('debug ログが console.log に出力される', () => {
    const logger = createLogger('token');
    logger.debug('デバッグ情報');
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('debug');
    expect(output.ctx).toBe('token');
    expect(output.msg).toBe('デバッグ情報');
  });

  it('warn ログが console.warn に出力される', () => {
    const logger = createLogger('service');
    logger.warn('警告メッセージ');
    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('warn');
    expect(output.ctx).toBe('service');
    expect(output.msg).toBe('警告メッセージ');
  });

  it('error ログが console.error に出力される', () => {
    const logger = createLogger('db');
    logger.error('エラーが発生しました');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('error');
    expect(output.ctx).toBe('db');
    expect(output.msg).toBe('エラーが発生しました');
  });

  it('Error オブジェクトを渡すと err と stack が設定される', () => {
    const logger = createLogger('token-introspect');
    const error = new Error('DB接続エラー');
    logger.error('エラー詳細', error);
    const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(output.err).toBe('DB接続エラー');
    expect(output.stack).toContain('DB接続エラー');
    expect(output.data).toBeUndefined();
  });

  it('非 Error オブジェクトを渡すと data に設定される', () => {
    const logger = createLogger('oauth-google');
    const extra = { userId: 'user-123', scope: 'openid' };
    logger.info('ユーザー情報', extra);
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.data).toEqual(extra);
    expect(output.err).toBeUndefined();
  });

  it('extra を渡さない場合は data/err/stack が含まれない', () => {
    const logger = createLogger('id');
    logger.info('シンプルなログ');
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.data).toBeUndefined();
    expect(output.err).toBeUndefined();
    expect(output.stack).toBeUndefined();
  });

  it('コンテキスト文字列が出力に反映される', () => {
    const logger = createLogger('token-pair');
    logger.info('テスト');
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.ctx).toBe('token-pair');
  });

  it('数値を extra として渡すと data に設定される', () => {
    const logger = createLogger('metrics');
    logger.debug('カウント', 42);
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(output.data).toBe(42);
  });

  it('null を extra として渡すと data に設定される', () => {
    const logger = createLogger('test');
    logger.warn('null値', null);
    const output = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
    expect(output.data).toBeNull();
  });
});
