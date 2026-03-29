/**
 * Notification channel CRUD routes.
 * Supports Slack webhooks, email, and custom webhooks with SSRF protection.
 * Ported from ChainAlert's channel patterns.
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { notificationChannels, slackInstallations } from '@sentinel/db/schema/core';
import { eq, and, isNull } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';
import { sendSlackMessage, type SlackAlertPayload } from '@sentinel/notifications/slack';
import { sendEmailNotification } from '@sentinel/notifications/email';
import { sendWebhookNotification } from '@sentinel/notifications/webhook';
import { encrypt, decrypt } from '@sentinel/shared/crypto';
import { env } from '@sentinel/shared/env';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const channelTypeEnum = z.enum(['email', 'webhook', 'slack']);

const emailConfigSchema = z.object({
  recipients: z.array(z.string().email('Each recipient must be a valid email'))
    .min(1, 'At least one recipient is required'),
});

const webhookConfigSchema = z.object({
  url: z.string().url('url must be a valid URL'),
  secret: z.string().optional(),
  headers: z.record(z.string().max(256), z.string().max(4096)).optional(),
});

const slackConfigSchema = z.object({
  channelId: z.string().min(1, 'Slack channel ID is required'),
});

const configSchemaByType: Record<string, z.ZodSchema> = {
  email: emailConfigSchema,
  webhook: webhookConfigSchema,
  slack: slackConfigSchema,
};

const BLOCKED_HEADERS = [
  'host', 'transfer-encoding', 'connection', 'content-length', 'cookie', 'authorization',
  'x-signature', 'content-type',
];

function stripBlockedHeaders(config: Record<string, unknown>) {
  const headers = config.headers as Record<string, string> | undefined;
  if (!headers) return;
  for (const blocked of BLOCKED_HEADERS) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === blocked) delete headers[key];
    }
  }
}

const createBodySchema = z.object({
  name: z.string().min(1).max(255),
  type: channelTypeEnum,
  config: z.record(z.string(), z.unknown()),
}).superRefine((data, ctx) => {
  const schema = configSchemaByType[data.type];
  if (schema) {
    const result = schema.safeParse(data.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      }
    }
  }
});

const updateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => data.name !== undefined || data.config !== undefined || data.enabled !== undefined,
  { message: 'At least one field must be provided' },
);

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  type: channelTypeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redact sensitive fields from channel config before returning to clients.
 */
function redactChannelConfig(channel: Record<string, unknown>): Record<string, unknown> {
  if (channel.type !== 'webhook') return channel;
  const config = channel.config as Record<string, unknown> | undefined;
  if (!config?.secret) return channel;
  return {
    ...channel,
    config: { ...config, secret: '***' },
  };
}

async function getOwnedChannel(db: ReturnType<typeof getDb>, id: string, orgId: string) {
  const [channel] = await db.select()
    .from(notificationChannels)
    .where(and(
      eq(notificationChannels.id, id),
      eq(notificationChannels.orgId, orgId),
      isNull(notificationChannels.deletedAt),
    ))
    .limit(1);
  return channel ?? null;
}

// ---------------------------------------------------------------------------
// POST /channels — create notification channel
// ---------------------------------------------------------------------------

router.post('/', requireRole('admin', 'editor'), requireScope('api:write'), validate('json', createBodySchema), async (c) => {
  const body = getValidated<z.infer<typeof createBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const db = getDb();

  // Reject email channels when SMTP is not configured
  if (body.type === 'email' && !env().SMTP_URL) {
    return c.json({ error: 'Email notifications require SMTP_URL to be configured. Contact your administrator.' }, 400);
  }

  // Strip blocked headers for webhooks
  if (body.type === 'webhook') {
    stripBlockedHeaders(body.config);
  }

  // Auto-generate webhook secret if not provided
  let generatedSecret: string | undefined;
  if (body.type === 'webhook' && !body.config.secret) {
    generatedSecret = crypto.randomBytes(32).toString('hex');
    body.config.secret = generatedSecret;
  }

  // Encrypt webhook secret before storing
  if (body.type === 'webhook' && body.config.secret) {
    body.config.secret = encrypt(body.config.secret as string);
  }

  const [channel] = await db.insert(notificationChannels).values({
    orgId,
    name: body.name,
    type: body.type,
    config: body.config,
    enabled: true,
  }).returning();

  return c.json({
    data: redactChannelConfig(channel),
    ...(generatedSecret ? { generatedSecret } : {}),
  }, 201);
});

// ---------------------------------------------------------------------------
// GET /channels — list channels
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(notificationChannels.orgId, orgId), isNull(notificationChannels.deletedAt)];
  if (query.type) conditions.push(eq(notificationChannels.type, query.type));

  const channels = await db.select()
    .from(notificationChannels)
    .where(and(...conditions))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({ data: channels.map((ch) => redactChannelConfig(ch)), limit: query.limit, offset: query.offset });
});

// ---------------------------------------------------------------------------
// GET /channels/:id — single channel
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const channel = await getOwnedChannel(db, id, orgId);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  return c.json({ data: redactChannelConfig(channel) });
});

// ---------------------------------------------------------------------------
// PATCH /channels/:id — update channel
// ---------------------------------------------------------------------------

router.patch('/:id', requireRole('admin', 'editor'), requireScope('api:write'), validate('param', idParamSchema), validate('json', updateBodySchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const body = getValidated<z.infer<typeof updateBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const db = getDb();

  const existing = await getOwnedChannel(db, id, orgId);
  if (!existing) return c.json({ error: 'Channel not found' }, 404);

  // Validate config against channel type if provided
  if (body.config) {
    const schema = configSchemaByType[existing.type];
    if (schema) {
      const result = schema.safeParse(body.config);
      if (!result.success) {
        return c.json({
          error: 'Validation failed',
          details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }, 400);
      }
    }

    if (existing.type === 'webhook') {
      stripBlockedHeaders(body.config);
      // Encrypt webhook secret if provided; preserve existing secret otherwise
      if (body.config.secret) {
        body.config.secret = encrypt(body.config.secret as string);
      } else if (body.config.secret === undefined && existing.config && (existing.config as Record<string, unknown>).secret) {
        body.config.secret = (existing.config as Record<string, unknown>).secret;
      }
    }
  }

  const updateSet: Record<string, unknown> = {};
  if (body.name !== undefined) updateSet.name = body.name;
  if (body.config !== undefined) updateSet.config = body.config;
  if (body.enabled !== undefined) updateSet.enabled = body.enabled;

  const [updated] = await db.update(notificationChannels)
    .set(updateSet)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, orgId)))
    .returning();

  return c.json({ data: redactChannelConfig(updated) });
});

// ---------------------------------------------------------------------------
// DELETE /channels/:id — soft delete (admin only)
// ---------------------------------------------------------------------------

router.delete('/:id', requireRole('admin'), requireScope('api:write'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const existing = await getOwnedChannel(db, id, orgId);
  if (!existing) return c.json({ error: 'Channel not found' }, 404);

  await db.update(notificationChannels)
    .set({ deletedAt: new Date() })
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, orgId)));

  return c.json({ data: { id, deleted: true } });
});

// ---------------------------------------------------------------------------
// POST /channels/:id/test — send test notification
// ---------------------------------------------------------------------------

router.post('/:id/test', requireRole('admin', 'editor'), requireScope('api:write'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const channel = await getOwnedChannel(db, id, orgId);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  if (!channel.enabled) return c.json({ error: 'Cannot test a disabled channel' }, 400);

  const config = channel.config as Record<string, unknown>;
  const testAlert: SlackAlertPayload = {
    title: 'Test Notification from Sentinel',
    severity: 'medium',
    description: 'This is a test notification to verify your channel configuration.',
    module: 'platform',
    eventType: 'test',
    timestamp: new Date().toISOString(),
  };

  try {
    switch (channel.type) {
      case 'email': {
        if (!env().SMTP_URL) {
          return c.json({ error: 'Email notifications require SMTP_URL to be configured. Contact your administrator.' }, 400);
        }
        const recipients = (config.recipients ?? []) as string[];
        if (!recipients.length) throw new Error('No recipients configured');
        await sendEmailNotification(recipients, testAlert);
        break;
      }
      case 'webhook': {
        const url = config.url as string;
        const encryptedSecret = config.secret as string;
        if (!url) throw new Error('No webhook URL configured');
        const secret = encryptedSecret ? decrypt(encryptedSecret) : '';
        await sendWebhookNotification(
          { url, secret, headers: config.headers as Record<string, string> },
          { alert: testAlert },
        );
        break;
      }
      case 'slack': {
        const channelId = config.channelId as string;
        if (!channelId) throw new Error('No Slack channel ID configured');
        const slackInstall = await db
          .select({ botToken: slackInstallations.botToken })
          .from(slackInstallations)
          .where(eq(slackInstallations.orgId, orgId))
          .limit(1)
          .then((rows) => rows[0]);
        const botToken = slackInstall ? decrypt(slackInstall.botToken) : process.env.SLACK_BOT_TOKEN;
        if (!botToken) throw new Error('No Slack bot token found. Install the Slack app or set SLACK_BOT_TOKEN.');
        await sendSlackMessage(botToken, channelId, testAlert);
        break;
      }
      default:
        return c.json({ error: `Testing not supported for channel type: ${channel.type}` }, 400);
    }

    return c.json({ data: { id, testSent: true } });
  } catch (err) {
    const reqLogger = c.get('logger');
    reqLogger.error({ err, channelId: id }, 'Test notification failed');
    return c.json({ error: 'Test notification failed. Check channel configuration and try again.' }, 502);
  }
});

export { router as channelsRouter };
