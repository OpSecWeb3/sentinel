/**
 * Chunk 034 — Channels: Update + soft delete + list (redacted secrets)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
} from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

// Ensure SMTP_URL is set before the app env is parsed so email channels can be created.
process.env.SMTP_URL = process.env.SMTP_URL || 'smtp://localhost:1025';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a channel via the API and return its id + the admin cookie. */
async function createChannel(
  adminCookie: string,
  overrides: Partial<{ name: string; type: string; config: Record<string, unknown> }> = {},
) {
  const res = await appRequest(app, 'POST', '/api/channels', {
    cookie: adminCookie,
    body: {
      name: overrides.name ?? 'Test Channel',
      type: overrides.type ?? 'slack',
      config: overrides.config ?? { channelId: 'C0123456789' },
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  return body.data;
}

describe('Chunk 034 — Channels: Update + soft delete + list', () => {
  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  it('should list channels for org', async () => {
    const admin = await setupAdmin(app);
    await createChannel(admin.cookie, { name: 'Channel A' });
    await createChannel(admin.cookie, { name: 'Channel B' });

    const res = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(2);
    const names = body.data.map((ch: any) => ch.name);
    expect(names).toContain('Channel A');
    expect(names).toContain('Channel B');
  });

  it('should filter channels by type', async () => {
    const admin = await setupAdmin(app);
    await createChannel(admin.cookie, { name: 'Slack One', type: 'slack', config: { channelId: 'C111' } });
    await createChannel(admin.cookie, {
      name: 'Webhook One',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/test' },
    });

    const res = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
      query: { type: 'webhook' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe('webhook');
  });

  it('should redact webhook secret in list responses', async () => {
    const admin = await setupAdmin(app);
    await createChannel(admin.cookie, {
      name: 'Secret Hook',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/secret', secret: 'super-secret-value' },
    });

    const res = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].config.secret).toBe('***');
  });

  it('should return empty list for org with no channels', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  it('should update channel name', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie, { name: 'Old Name' });

    const res = await appRequest(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
      body: { name: 'New Name' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.name).toBe('New Name');
  });

  it('should enable/disable channel toggle', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie);
    expect(channel.enabled).toBe(true);

    // Disable
    const disableRes = await appRequest(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
      body: { enabled: false },
    });

    expect(disableRes.status).toBe(200);
    const disabled = (await disableRes.json()) as any;
    expect(disabled.data.enabled).toBe(false);

    // Re-enable
    const enableRes = await appRequest(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
      body: { enabled: true },
    });

    expect(enableRes.status).toBe(200);
    const enabled = (await enableRes.json()) as any;
    expect(enabled.data.enabled).toBe(true);
  });

  it('should update channel config', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie, {
      type: 'slack',
      config: { channelId: 'C_OLD' },
    });

    const res = await appRequest(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
      body: { config: { channelId: 'C_NEW' } },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.config.channelId).toBe('C_NEW');
  });

  it('should reject update with no fields', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie);

    const res = await appRequest(app, 'PATCH', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
      body: {},
    });

    expect(res.status).toBe(400);
  });

  it('should return 404 when updating non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/api/channels/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
      body: { name: 'Ghost' },
    });

    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Soft delete
  // -----------------------------------------------------------------------

  it('should soft delete a channel', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie, { name: 'Doomed' });

    const delRes = await appRequest(app, 'DELETE', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
    });

    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as any;
    expect(delBody.data.deleted).toBe(true);
    expect(delBody.data.id).toBe(channel.id);
  });

  it('should not show soft-deleted channel in active list', async () => {
    const admin = await setupAdmin(app);
    const ch1 = await createChannel(admin.cookie, { name: 'Keep' });
    const ch2 = await createChannel(admin.cookie, { name: 'Delete Me' });

    // Delete one channel
    await appRequest(app, 'DELETE', `/api/channels/${ch2.id}`, {
      cookie: admin.cookie,
    });

    // List should only show the surviving channel
    const listRes = await appRequest(app, 'GET', '/api/channels', {
      cookie: admin.cookie,
    });

    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Keep');
  });

  it('should return 404 when deleting non-existent channel', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/api/channels/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(404);
  });

  it('should return 404 when fetching a soft-deleted channel by id', async () => {
    const admin = await setupAdmin(app);
    const channel = await createChannel(admin.cookie, { name: 'Deleted' });

    await appRequest(app, 'DELETE', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
    });

    const getRes = await appRequest(app, 'GET', `/api/channels/${channel.id}`, {
      cookie: admin.cookie,
    });

    expect(getRes.status).toBe(404);
  });
});
