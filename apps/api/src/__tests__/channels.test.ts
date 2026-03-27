/**
 * Integration tests for Sentinel notification channel routes (/api/channels).
 *
 * Covers CRUD operations, webhook secret auto-generation, blocked header
 * stripping, soft delete (admin only), and test notification endpoint.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { cleanTables, getTestSql } from './setup.js';
import {
  appRequest,
  login,
  setupAdmin,
  setupAdminAndViewer,
} from './helpers.js';

// Mock notification senders so tests do not make real HTTP calls or send emails
vi.mock('@sentinel/notifications/slack', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@sentinel/notifications/email', () => ({
  sendEmailNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@sentinel/notifications/webhook', () => ({
  sendWebhookNotification: vi.fn().mockResolvedValue(undefined),
}));

let app: Hono<AppEnv>;

beforeEach(async () => {
  await cleanTables();
  const mod = await import('../index.js');
  app = mod.default;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createEmailChannel(
  appInst: Hono<AppEnv>,
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await appRequest(appInst, 'POST', '/api/channels', {
    cookie,
    body: {
      name: 'Email Alerts',
      type: 'email',
      config: { recipients: ['team@example.com'] },
      ...overrides,
    },
  });
  const body = await res.json();
  return { res, body };
}

async function createWebhookChannel(
  appInst: Hono<AppEnv>,
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await appRequest(appInst, 'POST', '/api/channels', {
    cookie,
    body: {
      name: 'Webhook Alerts',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/sentinel' },
      ...overrides,
    },
  });
  const body = await res.json();
  return { res, body };
}

// ===========================================================================
// POST /api/channels -- create
// ===========================================================================

describe('POST /api/channels', () => {
  it('creates an email channel', async () => {
    const admin = await setupAdmin(app);
    const { res, body } = await createEmailChannel(app, admin.cookie);

    expect(res.status).toBe(201);
    expect(body.data).toBeDefined();
    expect(body.data.name).toBe('Email Alerts');
    expect(body.data.type).toBe('email');
    expect(body.data.config.recipients).toContain('team@example.com');
    expect(body.data.enabled).toBe(true);
  });

  it('creates a webhook channel and auto-generates secret', async () => {
    const admin = await setupAdmin(app);
    const { res, body } = await createWebhookChannel(app, admin.cookie);

    expect(res.status).toBe(201);
    expect(body.data.type).toBe('webhook');
    expect(body.data.config.url).toBe('https://hooks.example.com/sentinel');
    // Secret should be auto-generated (64 hex chars)
    expect(body.data.config.secret).toBeDefined();
    expect(body.data.config.secret.length).toBe(64);
    // The generated secret should also be returned at the top level
    expect(body.generatedSecret).toBe(body.data.config.secret);
  });

  it('keeps user-provided webhook secret', async () => {
    const admin = await setupAdmin(app);
    const { body } = await createWebhookChannel(app, admin.cookie, {
      config: { url: 'https://hooks.example.com/sentinel', secret: 'my-custom-secret' },
    });

    expect(body.data.config.secret).toBe('my-custom-secret');
    // No generatedSecret when user provides their own
    expect(body.generatedSecret).toBeUndefined();
  });

  it('strips blocked headers from webhook config', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Webhook With Bad Headers',
        type: 'webhook',
        config: {
          url: 'https://hooks.example.com/sentinel',
          headers: {
            'X-Custom': 'allowed',
            'Host': 'evil.com',
            'Authorization': 'Bearer stolen',
            'Cookie': 'session=abc',
            'Transfer-Encoding': 'chunked',
            'Connection': 'keep-alive',
            'Content-Length': '999',
          },
        },
      },
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    const headers = body.data.config.headers;
    expect(headers['X-Custom']).toBe('allowed');
    // All blocked headers should be stripped
    expect(headers['Host']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Transfer-Encoding']).toBeUndefined();
    expect(headers['Connection']).toBeUndefined();
    expect(headers['Content-Length']).toBeUndefined();
  });

  it('rejects email channel without recipients', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Email',
        type: 'email',
        config: { recipients: [] },
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects email channel with invalid email addresses', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Emails',
        type: 'email',
        config: { recipients: ['not-an-email'] },
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects webhook channel without url', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Webhook',
        type: 'webhook',
        config: {},
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid channel type', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Type',
        type: 'sms',
        config: {},
      },
    });
    expect(res.status).toBe(400);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await appRequest(app, 'POST', '/api/channels', {
      body: {
        name: 'Test',
        type: 'email',
        config: { recipients: ['a@b.com'] },
      },
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/channels -- list
// ===========================================================================

describe('GET /api/channels', () => {
  it('lists channels (excludes soft-deleted)', async () => {
    const admin = await setupAdmin(app);

    await createEmailChannel(app, admin.cookie);
    const { body: wh } = await createWebhookChannel(app, admin.cookie);

    // Soft delete the webhook channel
    await appRequest(app, 'DELETE', `/api/channels/${wh.data.id}`, {
      cookie: admin.cookie,
    });

    const res = await appRequest(app, 'GET', '/api/channels', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the email channel should be listed
    expect(body.data.length).toBe(1);
    expect(body.data[0].type).toBe('email');
  });

  it('filters by type', async () => {
    const admin = await setupAdmin(app);

    await createEmailChannel(app, admin.cookie);
    await createWebhookChannel(app, admin.cookie);

    const res = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
      query: { type: 'webhook' },
    });
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].type).toBe('webhook');
  });

  it('returns empty list when no channels exist', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/channels', { cookie: admin.cookie });
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

// ===========================================================================
// GET /api/channels/:id -- detail
// ===========================================================================

describe('GET /api/channels/:id', () => {
  it('returns single channel by ID', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'GET', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(created.data.id);
    expect(body.data.name).toBe('Email Alerts');
  });

  it('returns 404 for non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/channels/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for soft-deleted channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    // Soft delete
    await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });

    const res = await appRequest(app, 'GET', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// PATCH /api/channels/:id -- update
// ===========================================================================

describe('PATCH /api/channels/:id', () => {
  it('updates channel name', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { name: 'Renamed Channel' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed Channel');
  });

  it('updates channel config', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { config: { recipients: ['new@example.com', 'another@example.com'] } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.config.recipients).toContain('new@example.com');
    expect(body.data.config.recipients).toContain('another@example.com');
  });

  it('can disable/enable channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    // Disable
    const disableRes = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { enabled: false },
    });
    expect(disableRes.status).toBe(200);
    const disabled = await disableRes.json();
    expect(disabled.data.enabled).toBe(false);

    // Re-enable
    const enableRes = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { enabled: true },
    });
    const enabled = await enableRes.json();
    expect(enabled.data.enabled).toBe(true);
  });

  it('strips blocked headers from webhook update', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createWebhookChannel(app, admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: {
        config: {
          url: 'https://new-url.example.com',
          headers: {
            'X-Custom': 'ok',
            'Host': 'evil.com',
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.config.headers['X-Custom']).toBe('ok');
    expect(body.data.config.headers['Host']).toBeUndefined();
  });

  it('rejects invalid config for email channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { config: { recipients: [] } },
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty update body', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/api/channels/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
      body: { name: 'Ghost' },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// DELETE /api/channels/:id -- soft delete (admin only)
// ===========================================================================

describe('DELETE /api/channels/:id', () => {
  it('admin can soft-delete a channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(created.data.id);
    expect(body.data.deleted).toBe(true);

    // Verify the channel has a deleted_at timestamp in DB
    const sql = getTestSql();
    const [row] = await sql`SELECT deleted_at FROM notification_channels WHERE id = ${created.data.id}`;
    expect(row.deleted_at).not.toBeNull();
  });

  it('viewer cannot delete channel (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const res = await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: viewerCookie,
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for already deleted channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    // Delete once
    await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });

    // Delete again
    const res = await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/api/channels/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /api/channels/:id/test -- test notification
// ===========================================================================

describe('POST /api/channels/:id/test', () => {
  it('sends a test notification for email channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    const res = await appRequest(app, 'POST', `/api/channels/${created.data.id}/test`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.testSent).toBe(true);
  });

  it('sends a test notification for webhook channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createWebhookChannel(app, admin.cookie);

    const res = await appRequest(app, 'POST', `/api/channels/${created.data.id}/test`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.testSent).toBe(true);
  });

  it('cannot test a disabled channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    // Disable the channel
    await appRequest(app, 'PATCH', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
      body: { enabled: false },
    });

    const res = await appRequest(app, 'POST', `/api/channels/${created.data.id}/test`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('returns 404 for non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels/00000000-0000-0000-0000-000000000000/test', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for soft-deleted channel', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createEmailChannel(app, admin.cookie);

    // Soft delete
    await appRequest(app, 'DELETE', `/api/channels/${created.data.id}`, {
      cookie: admin.cookie,
    });

    const res = await appRequest(app, 'POST', `/api/channels/${created.data.id}/test`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });
});
