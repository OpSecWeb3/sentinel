import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------
const WEBHOOK_SECRET = 'test-webhook-secret-1234';
const INSTALLATION_ID = 'inst_abc123';

// Mock DB rows
const mockInstallation = {
  id: INSTALLATION_ID,
  orgId: 'org_1',
  installationId: BigInt(12345),
  status: 'active',
  webhookSecretEncrypted: 'encrypted-secret-placeholder',
};

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

// Mock @sentinel/shared/crypto
vi.mock('@sentinel/shared/crypto', () => ({
  decrypt: vi.fn(() => WEBHOOK_SECRET),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  generateApiKey: vi.fn(),
}));

// Mock @sentinel/shared/env
vi.mock('@sentinel/shared/env', () => ({
  env: () => ({
    SESSION_SECRET: 'a'.repeat(32),
    GITHUB_APP_CLIENT_ID: 'Iv1.test',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  }),
}));

// Mock @sentinel/db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock('@sentinel/db', () => ({
  getDb: () => ({
    select: () => ({ from: mockFrom }),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn() })) })) })),
    update: vi.fn(),
  }),
  eq: (col: any, val: any) => ({ col, val }),
  and: (...args: any[]) => args,
}));

// Mock @sentinel/db/schema/github
vi.mock('@sentinel/db/schema/github', () => ({
  githubInstallations: {
    id: 'id',
    orgId: 'org_id',
    installationId: 'installation_id',
    status: 'status',
  },
  githubRepositories: {},
}));

// Mock @sentinel/shared/queue
vi.mock('@sentinel/shared/queue', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
  QUEUE_NAMES: { MODULE_JOBS: 'module-jobs', EVENTS: 'events' },
}));

// Mock the github-api module
vi.mock('../github-api.js', () => ({
  getInstallationDetails: vi.fn(),
}));

// Mock the sync module
vi.mock('../sync.js', () => ({
  syncOptionsSchema: { parse: (v: any) => v },
}));

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ col, val }),
  and: (...args: any[]) => args,
}));

// Import the router after all mocks are set up
import { githubRouter } from '../router.js';

// ---------------------------------------------------------------------------
// Test app — mount the router
// ---------------------------------------------------------------------------
const app = new Hono();
app.route('/modules/github', githubRouter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sign(body: string, secret = WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function webhookRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': sign(body),
    'X-GitHub-Event': 'push',
    'X-GitHub-Delivery': 'delivery-123',
    ...headers,
  };

  return new Request(
    `http://localhost/modules/github/webhooks/${INSTALLATION_ID}`,
    {
      method: 'POST',
      headers: defaultHeaders,
      body,
    },
  );
}

// ---------------------------------------------------------------------------
// Set up DB mock behavior
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([mockInstallation]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GitHub webhook HMAC verification', () => {
  it('valid HMAC signature passes verification and returns 202', async () => {
    const body = JSON.stringify({ action: 'opened', ref: 'refs/heads/main' });
    const req = webhookRequest(body);

    const res = await app.request(req);
    expect(res.status).toBe(202);

    const json = await res.json();
    expect(json).toHaveProperty('received', true);
  });

  it('invalid signature returns 401', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = webhookRequest(body, {
      'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
    });

    const res = await app.request(req);
    expect(res.status).toBe(401);

    const json = await res.json();
    expect(json.error).toMatch(/invalid signature/i);
  });

  it('signature from wrong secret returns 401', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const wrongSig = 'sha256=' + createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    const req = webhookRequest(body, { 'X-Hub-Signature-256': wrongSig });

    const res = await app.request(req);
    expect(res.status).toBe(401);
  });

  it('missing X-Hub-Signature-256 header returns 400', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = new Request(
      `http://localhost/modules/github/webhooks/${INSTALLATION_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-GitHub-Delivery': 'delivery-123',
        },
        body,
      },
    );

    const res = await app.request(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/missing/i);
  });

  it('missing X-GitHub-Event header returns 400', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = new Request(
      `http://localhost/modules/github/webhooks/${INSTALLATION_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(body),
          'X-GitHub-Delivery': 'delivery-123',
        },
        body,
      },
    );

    const res = await app.request(req);
    expect(res.status).toBe(400);
  });

  it('missing X-GitHub-Delivery header returns 400', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = new Request(
      `http://localhost/modules/github/webhooks/${INSTALLATION_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(body),
          'X-GitHub-Event': 'push',
        },
        body,
      },
    );

    const res = await app.request(req);
    expect(res.status).toBe(400);
  });

  it('missing all webhook headers returns 400', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = new Request(
      `http://localhost/modules/github/webhooks/${INSTALLATION_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    );

    const res = await app.request(req);
    expect(res.status).toBe(400);
  });

  it('unknown installation returns 401 (anti-enumeration)', async () => {
    mockLimit.mockResolvedValueOnce([]); // no installation found

    const body = JSON.stringify({ action: 'opened' });
    const req = webhookRequest(body);

    const res = await app.request(req);
    expect(res.status).toBe(401);

    const json = await res.json();
    expect(json.error).toMatch(/invalid signature/i);
  });

  it('inactive installation returns 401 (anti-enumeration)', async () => {
    mockLimit.mockResolvedValueOnce([{ ...mockInstallation, status: 'removed' }]);

    const body = JSON.stringify({ action: 'opened' });
    const req = webhookRequest(body);

    const res = await app.request(req);
    expect(res.status).toBe(401);
  });

  it('valid request enqueues job with correct data', async () => {
    const { getQueue } = await import('@sentinel/shared/queue');
    const addMock = vi.fn();
    vi.mocked(getQueue).mockReturnValue({ add: addMock } as any);

    const payload = { action: 'opened', ref: 'refs/heads/main' };
    const body = JSON.stringify(payload);
    const req = webhookRequest(body);

    const res = await app.request(req);
    expect(res.status).toBe(202);

    expect(addMock).toHaveBeenCalledWith(
      'github.webhook.process',
      expect.objectContaining({
        deliveryId: 'delivery-123',
        eventType: 'push',
        installationId: INSTALLATION_ID,
        orgId: 'org_1',
      }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });
});
