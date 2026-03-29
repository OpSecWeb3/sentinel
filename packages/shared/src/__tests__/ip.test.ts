import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env to control TRUSTED_PROXY_COUNT
vi.mock('../env.js', () => ({
  env: vi.fn(() => ({ TRUSTED_PROXY_COUNT: 0 })),
}));

import { getClientIp } from '../ip.js';
import { env } from '../env.js';

const mockEnv = vi.mocked(env);

function fakeContext(headers: Record<string, string> = {}, remoteAddress?: string) {
  return {
    req: {
      header: (name: string) => headers[name],
    },
    env: remoteAddress ? { remoteAddress } : {},
  } as any;
}

describe('getClientIp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.mockReturnValue({ TRUSTED_PROXY_COUNT: 0 } as any);
  });

  it('returns remoteAddress when TRUSTED_PROXY_COUNT is 0', () => {
    const c = fakeContext({}, '10.0.0.1');
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  it('returns "unknown" when no remoteAddress and no proxy', () => {
    const c = fakeContext();
    expect(getClientIp(c)).toBe('unknown');
  });

  it('ignores X-Forwarded-For when TRUSTED_PROXY_COUNT is 0', () => {
    const c = fakeContext({ 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' }, '10.0.0.1');
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  it('reads correct XFF entry with TRUSTED_PROXY_COUNT=1', () => {
    mockEnv.mockReturnValue({ TRUSTED_PROXY_COUNT: 1 } as any);
    // Client=1.1.1.1, Proxy=2.2.2.2 → index = 2 - 1 = 1 → "2.2.2.2" is proxy, "1.1.1.1" is client
    // Wait: parts.length - trustedProxyCount = 2 - 1 = 1 → parts[1] = "2.2.2.2"
    // Actually with 1 proxy, we want the entry before the proxy: index = max(0, 2-1) = 1 → parts[1]
    // That gives us the last entry. With nginx as the sole proxy, it appends client IP, so:
    // XFF = "spoofed, real-client" where real-client was set by nginx
    // index = max(0, 2-1) = 1 → parts[1] = real-client ✓
    const c = fakeContext({ 'X-Forwarded-For': '1.1.1.1, 203.0.113.5' });
    expect(getClientIp(c)).toBe('203.0.113.5');
  });

  it('reads correct XFF entry with TRUSTED_PROXY_COUNT=2', () => {
    mockEnv.mockReturnValue({ TRUSTED_PROXY_COUNT: 2 } as any);
    // 3 entries, 2 trusted proxies → index = max(0, 3-2) = 1
    const c = fakeContext({ 'X-Forwarded-For': '10.0.0.1, 192.168.1.1, 172.16.0.1' });
    expect(getClientIp(c)).toBe('192.168.1.1');
  });

  it('returns first entry when proxy count exceeds XFF length', () => {
    mockEnv.mockReturnValue({ TRUSTED_PROXY_COUNT: 5 } as any);
    const c = fakeContext({ 'X-Forwarded-For': '1.2.3.4' });
    // max(0, 1-5) = 0 → parts[0]
    expect(getClientIp(c)).toBe('1.2.3.4');
  });

  it('falls back to remoteAddress when XFF missing with proxy configured', () => {
    mockEnv.mockReturnValue({ TRUSTED_PROXY_COUNT: 1 } as any);
    const c = fakeContext({}, '127.0.0.1');
    expect(getClientIp(c)).toBe('127.0.0.1');
  });
});
