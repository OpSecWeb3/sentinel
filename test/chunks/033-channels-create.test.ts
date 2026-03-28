/**
 * Chunk 033 — Channels: Create (email/webhook/slack validation, SSRF header blocking, secret encryption)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters, getTestSql } from '../helpers/setup.js';
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

describe('Chunk 033 — Channels: Create', () => {
  // -----------------------------------------------------------------------
  // Email channel
  // -----------------------------------------------------------------------

  it('should create an email channel with valid config', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Ops Email',
        type: 'email',
        config: {
          recipients: ['ops@example.com'],
        },
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data).toBeDefined();
    expect(body.data.name).toBe('Ops Email');
    expect(body.data.type).toBe('email');
    expect(body.data.enabled).toBe(true);
    expect(body.data.id).toBeDefined();
  });

  it('should reject email channel with empty recipients array', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Email',
        type: 'email',
        config: {
          recipients: [],
        },
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject email channel with invalid email address', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Email',
        type: 'email',
        config: {
          recipients: ['not-an-email'],
        },
      },
    });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Webhook channel
  // -----------------------------------------------------------------------

  it('should create a webhook channel with valid URL', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Deploy Hook',
        type: 'webhook',
        config: {
          url: 'https://hooks.example.com/sentinel',
        },
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.type).toBe('webhook');
    expect(body.data.name).toBe('Deploy Hook');
    // A secret should be auto-generated and returned (but redacted in the data)
    expect(body.generatedSecret).toBeDefined();
    expect(typeof body.generatedSecret).toBe('string');
    expect(body.generatedSecret.length).toBeGreaterThan(0);
    // The stored config secret should be redacted
    expect(body.data.config.secret).toBe('***');
  });

  it('should create a webhook channel with explicit secret', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Custom Secret Hook',
        type: 'webhook',
        config: {
          url: 'https://hooks.example.com/custom',
          secret: 'my-custom-secret',
        },
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // No generatedSecret when the user provides one
    expect(body.generatedSecret).toBeUndefined();
    // The stored secret should be redacted
    expect(body.data.config.secret).toBe('***');
  });

  it('should reject webhook channel with missing URL', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'No URL Hook',
        type: 'webhook',
        config: {},
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject webhook channel with invalid URL', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad URL Hook',
        type: 'webhook',
        config: {
          url: 'not-a-valid-url',
        },
      },
    });

    expect(res.status).toBe(400);
  });

  it('should strip blocked headers from webhook config', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Header Hook',
        type: 'webhook',
        config: {
          url: 'https://hooks.example.com/headers',
          headers: {
            'Authorization': 'Bearer evil',
            'Cookie': 'session=hijack',
            'Host': 'attacker.com',
            'X-Custom': 'allowed-header',
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const headers = body.data.config.headers as Record<string, string>;
    // Blocked headers should have been stripped
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Host']).toBeUndefined();
    // Custom header should remain
    expect(headers['X-Custom']).toBe('allowed-header');
  });

  // -----------------------------------------------------------------------
  // Slack channel
  // -----------------------------------------------------------------------

  it('should create a Slack channel with channelId', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Alerts Slack',
        type: 'slack',
        config: {
          channelId: 'C0123456789',
        },
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.type).toBe('slack');
    expect(body.data.config.channelId).toBe('C0123456789');
  });

  it('should reject Slack channel without channelId', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Slack',
        type: 'slack',
        config: {},
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject Slack channel with empty channelId', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Slack',
        type: 'slack',
        config: {
          channelId: '',
        },
      },
    });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Invalid type
  // -----------------------------------------------------------------------

  it('should reject an invalid channel type', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'SMS Channel',
        type: 'sms',
        config: { phoneNumber: '+1234567890' },
      },
    });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Required fields
  // -----------------------------------------------------------------------

  it('should require a channel name', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        type: 'slack',
        config: { channelId: 'C12345' },
      },
    });

    expect(res.status).toBe(400);
  });

  it('should require a channel type', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'No Type',
        config: { channelId: 'C12345' },
      },
    });

    expect(res.status).toBe(400);
  });

  it('should require config', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/channels', {
      cookie: admin.cookie,
      body: {
        name: 'No Config',
        type: 'slack',
      },
    });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  it('should reject unauthenticated channel creation', async () => {
    const res = await appRequest(app, 'POST', '/api/channels', {
      body: {
        name: 'Unauthed',
        type: 'slack',
        config: { channelId: 'C12345' },
      },
    });

    expect(res.status).toBe(401);
  });
});
