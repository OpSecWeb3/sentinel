/**
 * Integration routes — Slack OAuth flow, channel search, disconnect.
 * Ported from ChainAlert's integration patterns.
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { slackInstallations, detections } from '@sentinel/db/schema/core';
import { eq } from '@sentinel/db';
import { encrypt, decrypt } from '@sentinel/shared/crypto';
import { env } from '@sentinel/shared/env';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';

const integrations = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// State signing for OAuth CSRF protection
// ---------------------------------------------------------------------------

function signState(payload: string): string {
  return crypto.createHmac('sha256', env().SESSION_SECRET).update(payload).digest('hex');
}

function verifyState(payload: string, signature: string): boolean {
  const expected = signState(payload);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Public routes (OAuth callback — must be before auth middleware)
// ---------------------------------------------------------------------------

integrations.get('/slack/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const webUrl = env().ALLOWED_ORIGINS.split(',')[0]?.trim() ?? 'http://localhost:3000';

  if (!code || !stateParam) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=missing_params`);
  }

  // Parse and verify state
  const dotIdx = stateParam.lastIndexOf('.');
  if (dotIdx === -1) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=invalid_state`);
  }

  const stateB64 = stateParam.slice(0, dotIdx);
  const stateSig = stateParam.slice(dotIdx + 1);

  let statePayload: string;
  try {
    statePayload = Buffer.from(stateB64, 'base64url').toString();
  } catch {
    return c.redirect(`${webUrl}/settings?slack=error&reason=invalid_state`);
  }

  if (!verifyState(statePayload, stateSig)) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=invalid_signature`);
  }

  let parsedState: { orgId: string; userId: string; ts: number };
  try {
    parsedState = JSON.parse(statePayload) as { orgId: string; userId: string; ts: number };
  } catch {
    return c.redirect(`${webUrl}/settings?slack=error&reason=invalid_state`);
  }
  const { orgId, userId, ts } = parsedState;

  if (Date.now() - ts > MAX_STATE_AGE_MS) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=expired_state`);
  }

  // Exchange code for token
  const slackClientId = env().SLACK_CLIENT_ID;
  const slackClientSecret = env().SLACK_CLIENT_SECRET;
  if (!slackClientId || !slackClientSecret) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=not_configured`);
  }

  const redirectUri = `${env().API_BASE_URL}/integrations/slack/callback`;

  const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: slackClientId,
      client_secret: slackClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    ok: boolean;
    access_token?: string;
    bot_user_id?: string;
    team?: { id: string; name: string };
    error?: string;
  };

  if (!tokenData.ok || !tokenData.access_token || !tokenData.team) {
    return c.redirect(`${webUrl}/settings?slack=error&reason=${tokenData.error ?? 'token_exchange_failed'}`);
  }

  // Encrypt and store
  const db = getDb();
  const encryptedToken = encrypt(tokenData.access_token);

  await db.insert(slackInstallations).values({
    orgId,
    teamId: tokenData.team.id,
    teamName: tokenData.team.name,
    botToken: encryptedToken,
    botUserId: tokenData.bot_user_id ?? '',
    installedBy: userId,
  }).onConflictDoUpdate({
    target: slackInstallations.orgId,
    set: {
      teamId: tokenData.team.id,
      teamName: tokenData.team.name,
      botToken: encryptedToken,
      botUserId: tokenData.bot_user_id ?? '',
      installedBy: userId,
    },
  });

  return c.redirect(`${webUrl}/settings?slack=success`);
});

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

const authed = new Hono<AppEnv>();
authed.use('*', requireAuth, requireOrg);

// GET /integrations/slack — connection status
authed.get('/slack', async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const [installation] = await db.select({
    teamId: slackInstallations.teamId,
    teamName: slackInstallations.teamName,
    createdAt: slackInstallations.createdAt,
  }).from(slackInstallations).where(eq(slackInstallations.orgId, orgId)).limit(1);

  if (!installation) return c.json({ connected: false });
  return c.json({
    connected: true,
    teamId: installation.teamId,
    teamName: installation.teamName,
    installedAt: installation.createdAt,
  });
});

// GET /integrations/slack/install — get OAuth URL
authed.get('/slack/install', async (c) => {
  const slackClientId = env().SLACK_CLIENT_ID;
  if (!slackClientId) {
    return c.json({ error: 'Slack not configured on this server' }, 501);
  }

  const orgId = c.get('orgId');
  const userId = c.get('userId');

  const statePayload = JSON.stringify({ orgId, userId, ts: Date.now() });
  const stateB64 = Buffer.from(statePayload).toString('base64url');
  const stateSig = signState(statePayload);
  const state = `${stateB64}.${stateSig}`;

  // Build the callback URL from the configured API base URL (not from request headers)
  const redirectUri = `${env().API_BASE_URL}/integrations/slack/callback`;

  const params = new URLSearchParams({
    client_id: slackClientId,
    scope: 'chat:write,channels:read,groups:read',
    redirect_uri: redirectUri,
    state,
  });

  return c.json({ url: `https://slack.com/oauth/v2/authorize?${params}` });
});

// DELETE /integrations/slack — disconnect (admin only)
authed.delete('/slack', requireRole('admin'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  await db.delete(slackInstallations).where(eq(slackInstallations.orgId, orgId));

  // Clear slack channel references from detections
  await db.update(detections)
    .set({ slackChannelId: null, slackChannelName: null })
    .where(eq(detections.orgId, orgId));

  return c.json({ disconnected: true });
});

// GET /integrations/slack/channels?q=search — search Slack channels
authed.get('/slack/channels', async (c) => {
  const query = (c.req.query('q') ?? '').trim().toLowerCase();
  if (query.length < 2) return c.json({ channels: [] });

  const orgId = c.get('orgId');
  const db = getDb();

  const [installation] = await db.select({ botToken: slackInstallations.botToken })
    .from(slackInstallations).where(eq(slackInstallations.orgId, orgId)).limit(1);

  if (!installation) return c.json({ error: 'Slack is not connected' }, 400);

  const token = decrypt(installation.botToken);
  const matched: Array<{ id: string; name: string; isPrivate: boolean }> = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      exclude_archived: 'true',
      types: 'public_channel,private_channel',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string; is_private: boolean }>;
      response_metadata?: { next_cursor?: string };
    };

    if (!data.ok) {
      console.error('[slack] conversations.list failed:', data.error ?? 'unknown');
      return c.json({ error: 'Failed to fetch channels from Slack' }, 502);
    }

    for (const ch of data.channels ?? []) {
      if (ch.name.toLowerCase().includes(query)) {
        matched.push({ id: ch.id, name: ch.name, isPrivate: ch.is_private });
      }
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor && matched.length < 50);

  return c.json({ channels: matched.slice(0, 50) });
});

// GET /integrations/slack/channels/:channelId — resolve channel ID to name
authed.get('/slack/channels/:channelId', async (c) => {
  const channelId = c.req.param('channelId');
  const orgId = c.get('orgId');
  const db = getDb();

  const [installation] = await db.select({ botToken: slackInstallations.botToken })
    .from(slackInstallations).where(eq(slackInstallations.orgId, orgId)).limit(1);

  if (!installation) return c.json({ error: 'Slack is not connected' }, 400);

  const token = decrypt(installation.botToken);
  const res = await fetch(
    `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const data = (await res.json()) as {
    ok: boolean;
    channel?: { id: string; name: string; is_private: boolean };
    error?: string;
  };

  if (!data.ok || !data.channel) {
    console.error('[slack] conversations.info failed:', data.error ?? 'unknown');
    return c.json({ error: 'Could not resolve the specified Slack channel' }, 404);
  }

  return c.json({
    id: data.channel.id,
    name: data.channel.name,
    isPrivate: data.channel.is_private,
  });
});

// Mount authenticated routes
integrations.route('/', authed);

export { integrations as integrationsRouter };
