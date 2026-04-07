import { describe, it, expect } from 'vitest';
import { getClientIp } from './ip';

describe('getClientIp', () => {
  it('cf-connecting-ip ヘッダーが存在する場合はその値を返す', () => {
    const req = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('cf-connecting-ip ヘッダーが存在しない場合は null を返す', () => {
    const req = new Request('https://example.com');
    expect(getClientIp(req)).toBeNull();
  });

  it('x-forwarded-for のみ存在する場合は null を返す（偽装防止）', () => {
    const req = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect(getClientIp(req)).toBeNull();
  });

  it('cf-connecting-ip と x-forwarded-for が両方存在する場合は cf-connecting-ip を返す', () => {
    const req = new Request('https://example.com', {
      headers: {
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '9.9.9.9',
      },
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('IPv6アドレスも正しく返す', () => {
    const req = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '2001:db8::1' },
    });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });
});
