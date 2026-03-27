import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackAlertPayload } from '../slack.js';
import type { ChannelRow, NotificationResult } from '../dispatcher.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../slack.js', () => ({
  sendSlackMessage: vi.fn(),
}));

vi.mock('../email.js', () => ({
  sendEmailNotification: vi.fn(),
}));

vi.mock('../webhook.js', () => ({
  sendWebhookNotification: vi.fn(),
}));

vi.mock('@sentinel/shared/crypto', () => ({
  decrypt: vi.fn((v: string) => v),
  encrypt: vi.fn((v: string) => v),
}));

// Import after mocks
import { dispatchAlert } from '../dispatcher.js';
import { sendSlackMessage } from '../slack.js';
import { sendEmailNotification } from '../email.js';
import { sendWebhookNotification } from '../webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseAlert(): SlackAlertPayload {
  return {
    title: 'New release detected',
    severity: 'high',
    description: 'nginx:latest digest changed',
    module: 'registry',
    eventType: 'registry.docker.digest_change',
    fields: [
      { label: 'Artifact', value: 'library/nginx' },
      { label: 'Tag', value: 'latest' },
    ],
    timestamp: new Date().toISOString(),
  };
}

function emailChannel(id = 'ch-email-1'): ChannelRow {
  return {
    id,
    type: 'email',
    config: { recipients: ['ops@example.com', 'sec@example.com'] },
  };
}

function webhookChannel(id = 'ch-webhook-1'): ChannelRow {
  return {
    id,
    type: 'webhook',
    config: {
      url: 'https://hooks.example.com/sentinel',
      secret: 'whsec_abc123',
      headers: { 'X-Custom': 'sentinel' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Slack bot token (direct channel)
// ===========================================================================

describe('dispatchAlert — Slack bot token', () => {
  it('dispatches to Slack bot token (direct channel)', async () => {
    const alert = baseAlert();
    const results = await dispatchAlert([], alert, 'xoxb-token', 'C012345');

    expect(sendSlackMessage).toHaveBeenCalledWith('xoxb-token', 'C012345', alert, undefined);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelId: 'C012345',
      type: 'slack',
      status: 'sent',
    });
  });

  it('captures error when Slack bot token dispatch fails', async () => {
    vi.mocked(sendSlackMessage).mockRejectedValueOnce(new Error('invalid_auth'));

    // With no other channels, all fail -> throws
    await expect(
      dispatchAlert([], baseAlert(), 'xoxb-bad', 'C012345'),
    ).rejects.toThrow('All notification channels failed');
  });
});

// ===========================================================================
// Email channel
// ===========================================================================

describe('dispatchAlert — email channel', () => {
  it('dispatches to email channel', async () => {
    const results = await dispatchAlert([emailChannel()], baseAlert());

    expect(sendEmailNotification).toHaveBeenCalledWith(
      ['ops@example.com', 'sec@example.com'],
      baseAlert(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelId: 'ch-email-1',
      type: 'email',
      status: 'sent',
    });
  });
});

// ===========================================================================
// Webhook channel
// ===========================================================================

describe('dispatchAlert — webhook channel', () => {
  it('dispatches to webhook channel', async () => {
    const alert = baseAlert();
    const results = await dispatchAlert([webhookChannel()], alert);

    expect(sendWebhookNotification).toHaveBeenCalledWith(
      {
        url: 'https://hooks.example.com/sentinel',
        secret: 'whsec_abc123',
        headers: { 'X-Custom': 'sentinel' },
      },
      { alert },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelId: 'ch-webhook-1',
      type: 'webhook',
      status: 'sent',
    });
  });
});

// ===========================================================================
// Multiple channels — all succeed
// ===========================================================================

describe('dispatchAlert — multiple channels', () => {
  it('dispatches to all channels and all succeed', async () => {
    const channels = [emailChannel(), webhookChannel()];

    const results = await dispatchAlert(channels, baseAlert());

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'sent')).toBe(true);
    expect(sendEmailNotification).toHaveBeenCalledTimes(1);
    expect(sendWebhookNotification).toHaveBeenCalledTimes(1);
  });

  it('includes bot token result when combined with configured channels', async () => {
    const channels = [emailChannel()];

    const results = await dispatchAlert(channels, baseAlert(), 'xoxb-token', 'C012345');

    // Bot token + email
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ channelId: 'C012345', type: 'slack', status: 'sent' });
    expect(results[1]).toMatchObject({ channelId: 'ch-email-1', type: 'email', status: 'sent' });
  });
});

// ===========================================================================
// Partial failure
// ===========================================================================

describe('dispatchAlert — partial failure', () => {
  it('returns results without throwing when one channel fails and others succeed', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('SMTP timeout'));

    const channels = [emailChannel(), webhookChannel()];
    const results = await dispatchAlert(channels, baseAlert());

    expect(results).toHaveLength(2);

    const emailResult = results.find((r) => r.type === 'email')!;
    expect(emailResult.status).toBe('failed');
    expect(emailResult.error).toBe('SMTP timeout');

    const webhookResult = results.find((r) => r.type === 'webhook')!;
    expect(webhookResult.status).toBe('sent');
  });

  it('captures per-channel error messages', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('SMTP refused'));
    vi.mocked(sendWebhookNotification).mockRejectedValueOnce(new Error('Connection refused'));

    const channels = [emailChannel(), webhookChannel()];

    // When ALL channels fail, dispatchAlert throws with combined error messages
    try {
      await dispatchAlert(channels, baseAlert());
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('email: SMTP refused');
      expect(msg).toContain('webhook: Connection refused');
    }
  });
});

// ===========================================================================
// All channels fail -> throws (triggers BullMQ retry)
// ===========================================================================

describe('dispatchAlert — all channels fail', () => {
  it('throws error when ALL channels fail', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('SMTP down'));
    vi.mocked(sendWebhookNotification).mockRejectedValueOnce(new Error('Connection refused'));

    const channels = [emailChannel(), webhookChannel()];

    await expect(dispatchAlert(channels, baseAlert())).rejects.toThrow(
      'All notification channels failed',
    );
  });

  it('includes all channel errors in the thrown message', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('SMTP down'));
    vi.mocked(sendWebhookNotification).mockRejectedValueOnce(new Error('DNS failure'));

    const channels = [emailChannel(), webhookChannel()];

    try {
      await dispatchAlert(channels, baseAlert());
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('email: SMTP down');
      expect(msg).toContain('webhook: DNS failure');
    }
  });
});

// ===========================================================================
// Empty channel list
// ===========================================================================

describe('dispatchAlert — empty channel list', () => {
  it('returns only Slack result when channels are empty but bot token is provided', async () => {
    const results = await dispatchAlert([], baseAlert(), 'xoxb-token', 'C012345');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelId: 'C012345',
      type: 'slack',
      status: 'sent',
    });
  });

  it('returns empty results when channels are empty and no Slack bot token', async () => {
    const results = await dispatchAlert([], baseAlert());

    expect(results).toHaveLength(0);
  });

  it('returns empty results when bot token is null', async () => {
    const results = await dispatchAlert([], baseAlert(), null, null);

    expect(results).toHaveLength(0);
  });
});

// ===========================================================================
// Notification status logic: sent / failed / partial
// ===========================================================================

describe('dispatchAlert — status semantics', () => {
  it('all sent: every result has status "sent"', async () => {
    const channels = [emailChannel(), webhookChannel()];
    const results = await dispatchAlert(channels, baseAlert());

    expect(results.every((r) => r.status === 'sent')).toBe(true);
  });

  it('partial: mix of sent and failed statuses', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('fail'));

    const channels = [emailChannel(), webhookChannel()];
    const results = await dispatchAlert(channels, baseAlert());

    const statuses = new Set(results.map((r) => r.status));
    expect(statuses.has('sent')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
  });

  it('all failed: throws error, does not return results', async () => {
    vi.mocked(sendEmailNotification).mockRejectedValueOnce(new Error('fail'));

    const channels = [emailChannel()];
    await expect(dispatchAlert(channels, baseAlert())).rejects.toThrow();
  });

  it('unknown channel type is skipped without adding to results', async () => {
    const unknownChannel: ChannelRow = { id: 'ch-unknown', type: 'pager', config: {} };
    const results = await dispatchAlert([unknownChannel, emailChannel()], baseAlert());

    // Only email result; pager is skipped via continue
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('email');
  });

  it('webhook channel missing url or secret fails with descriptive error', async () => {
    const badWebhook: ChannelRow = { id: 'ch-bad-wh', type: 'webhook', config: { url: 'https://x.com' } };

    await expect(dispatchAlert([badWebhook], baseAlert())).rejects.toThrow(
      'All notification channels failed',
    );
  });
});
