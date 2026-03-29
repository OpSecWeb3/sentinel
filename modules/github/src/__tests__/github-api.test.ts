import { describe, it, expect, vi, beforeAll } from 'vitest';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Generate a real RSA key pair once for all tests
// ---------------------------------------------------------------------------

let pemKey: string;
let singleLineKey: string; // PEM with literal \n (as stored in SSM / Docker env_file)

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  pemKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  // Simulate how Docker env_file delivers the key: literal \n instead of newlines
  singleLineKey = pemKey.replace(/\n/g, '\\n');
});

// ---------------------------------------------------------------------------
// Mock env — will be overridden per-test via vi.mocked
// ---------------------------------------------------------------------------

vi.mock('@sentinel/shared/env', () => ({
  env: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateAppJwt', () => {
  it('accepts a PEM key with actual newlines (local dev format)', async () => {
    const { env } = await import('@sentinel/shared/env');
    vi.mocked(env).mockReturnValue({
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: pemKey,
    } as never);

    const { generateAppJwt } = await import('../github-api.js');
    expect(() => generateAppJwt()).not.toThrow();
  });

  it('accepts a PEM key with literal \\n separators (SSM / Docker env_file format)', async () => {
    const { env } = await import('@sentinel/shared/env');
    vi.mocked(env).mockReturnValue({
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: singleLineKey,
    } as never);

    const { generateAppJwt } = await import('../github-api.js');
    // Without normalization this throws: error:09091064:PEM routines:no start line
    expect(() => generateAppJwt()).not.toThrow();
  });

  it('returns a three-part JWT string', async () => {
    const { env } = await import('@sentinel/shared/env');
    vi.mocked(env).mockReturnValue({
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: singleLineKey,
    } as never);

    const { generateAppJwt } = await import('../github-api.js');
    const jwt = generateAppJwt();
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('throws when GITHUB_APP_PRIVATE_KEY is missing', async () => {
    const { env } = await import('@sentinel/shared/env');
    vi.mocked(env).mockReturnValue({
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: undefined,
    } as never);

    const { generateAppJwt } = await import('../github-api.js');
    expect(() => generateAppJwt()).toThrow('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
  });
});
