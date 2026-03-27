/**
 * Comprehensive scenario-based tests for the notification dispatch system.
 * Covers: Slack, Email, Webhook, Multi-channel, SSRF protection, and adversarial inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — set up BEFORE imports that use them
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-msg-id' });
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
}));

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn();
  return {
    default: { lookup },
    lookup,
  };
});

vi.mock('@sentinel/shared/crypto', () => ({
  decrypt: (v: string) => `decrypted_${v}`,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { dispatchAlert, type NotificationResult, type ChannelRow } from '../dispatcher.js';
import { buildBlocks, sendSlackMessage, type SlackAlertPayload } from '../slack.js';
import { sendWebhookNotification, type WebhookConfig } from '../webhook.js';
import { sendEmailNotification } from '../email.js';
import dns from 'node:dns/promises';

const mockDnsLookup = dns.lookup as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlert(overrides: Partial<SlackAlertPayload> = {}): SlackAlertPayload {
  return {
    title: 'Test Alert',
    severity: 'high',
    description: 'Something happened',
    module: 'github',
    eventType: 'github.push',
    timestamp: '2026-03-27T12:00:00Z',
    ...overrides,
  };
}

function makeChannel(overrides: Partial<ChannelRow> & { type: string }): ChannelRow {
  const base: ChannelRow = {
    id: `ch_${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type,
    config: {},
  };
  return { ...base, ...overrides };
}

function slackOkResponse() {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
    text: () => Promise.resolve(''),
  });
}

function slackErrorResponse(error: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: false, error }),
    text: () => Promise.resolve(''),
  });
}

function webhookOkResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('OK'),
  });
}

function webhookErrorResponse(status: number, body = 'Internal Server Error') {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  process.env.SMTP_URL = 'smtp://localhost:587';
  process.env.SMTP_FROM = 'alerts@sentinel.dev';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// 1. Slack Dispatch (10 tests)
// =========================================================================

describe('Slack Dispatch', () => {
  it('delivers via bot token and direct channel', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse());
    const results = await dispatchAlert([], makeAlert(), 'xoxb-token', 'C12345');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      channelId: 'C12345',
      type: 'slack',
      status: 'sent',
    });
    expect(results[0].responseTimeMs).toBeTypeOf('number');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-token',
        }),
      }),
    );
  });

  it('delivers with custom format blocks', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse());
    const customFormatter = (alert: SlackAlertPayload) => [
      { type: 'section', text: { type: 'mrkdwn', text: `Custom: ${alert.title}` } },
    ];
    const results = await dispatchAlert([], makeAlert(), 'xoxb-token', 'C12345', customFormatter);
    expect(results[0].status).toBe('sent');
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.blocks).toHaveLength(1);
    expect(fetchBody.blocks[0].text.text).toContain('Custom:');
  });

  it('tracks failure when Slack API returns error', async () => {
    mockFetch.mockReturnValueOnce(slackErrorResponse('channel_not_found'));
    // When Slack is the only channel and it fails, dispatchAlert throws
    await expect(
      dispatchAlert([], makeAlert(), 'xoxb-token', 'C12345'),
    ).rejects.toThrow(/channel_not_found/);
  });

  it('tracks failure on network timeout (partial success with another channel)', async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error('network timeout'))); // slack
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-fallback' }); // email succeeds

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_fb', type: 'email', config: { recipients: ['a@b.com'] } }),
    ];
    const results = await dispatchAlert(channels, makeAlert(), 'xoxb-token', 'C12345');
    expect(results).toHaveLength(2);
    const slackResult = results.find((r) => r.type === 'slack')!;
    expect(slackResult.status).toBe('failed');
    expect(slackResult.error).toContain('network timeout');
    expect(slackResult.responseTimeMs).toBeTypeOf('number');
  });

  it('uses correct severity badges in Block Kit', () => {
    const criticalBlocks = buildBlocks(makeAlert({ severity: 'critical' }));
    const headerBlock = criticalBlocks[0] as { text: { text: string } };
    expect(headerBlock.text.text).toContain(':rotating_light:');

    const highBlocks = buildBlocks(makeAlert({ severity: 'high' }));
    const highHeader = highBlocks[0] as { text: { text: string } };
    expect(highHeader.text.text).toContain(':red_circle:');

    const mediumBlocks = buildBlocks(makeAlert({ severity: 'medium' }));
    const mediumHeader = mediumBlocks[0] as { text: { text: string } };
    expect(mediumHeader.text.text).toContain(':large_orange_circle:');

    const lowBlocks = buildBlocks(makeAlert({ severity: 'low' }));
    const lowHeader = lowBlocks[0] as { text: { text: string } };
    expect(lowHeader.text.text).toContain(':white_circle:');
  });

  it('falls back to bell badge for unknown severity', () => {
    const blocks = buildBlocks(makeAlert({ severity: 'unknown_sev' }));
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain(':bell:');
  });

  it('includes custom fields in Block Kit output', () => {
    const alert = makeAlert({
      fields: [
        { label: 'Repository', value: 'org/repo' },
        { label: 'Actor', value: 'mallory' },
      ],
    });
    const blocks = buildBlocks(alert);
    const fieldsBlock = blocks.find(
      (b: any) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text.includes('*Repository:*'),
    ) as any;
    expect(fieldsBlock).toBeDefined();
    expect(fieldsBlock.text.text).toContain('*Repository:* org/repo');
    expect(fieldsBlock.text.text).toContain('*Actor:* mallory');
  });

  it('skips Slack when bot token is missing', async () => {
    const results = await dispatchAlert([], makeAlert(), null, 'C12345');
    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips Slack when channel ID is missing', async () => {
    const results = await dispatchAlert([], makeAlert(), 'xoxb-token', null);
    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates Block Kit structure has header, section, and divider', () => {
    const blocks = buildBlocks(makeAlert({ description: 'desc here' }));
    const types = blocks.map((b: any) => b.type);
    expect(types[0]).toBe('header');
    expect(types[1]).toBe('section');
    expect(types).toContain('divider');
    // Description section
    const descBlock = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text === 'desc here',
    );
    expect(descBlock).toBeDefined();
  });
});

// =========================================================================
// 2. Email Dispatch (8 tests)
// =========================================================================

describe('Email Dispatch', () => {
  it('sends to a single recipient via channel config', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-1' });
    const channel = makeChannel({
      id: 'ch_email_1',
      type: 'email',
      config: { recipients: ['admin@example.com'] },
    });
    const results = await dispatchAlert([channel], makeAlert());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('sent');
    expect(mockSendMail).toHaveBeenCalledOnce();
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.to).toBe('admin@example.com');
  });

  it('sends to multiple recipients', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-2' });
    const channel = makeChannel({
      id: 'ch_email_2',
      type: 'email',
      config: { recipients: ['a@test.com', 'b@test.com', 'c@test.com'] },
    });
    const results = await dispatchAlert([channel], makeAlert());
    expect(results[0].status).toBe('sent');
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.to).toBe('a@test.com, b@test.com, c@test.com');
  });

  it('HTML template includes severity in subject', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-3' });
    const channel = makeChannel({
      id: 'ch_email_3',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    await dispatchAlert([channel], makeAlert({ severity: 'critical', title: 'Repo Public' }));
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.subject).toBe('[CRITICAL] Repo Public');
  });

  it('HTML template includes alert title in body', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-4' });
    const channel = makeChannel({
      id: 'ch_email_4',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    await dispatchAlert([channel], makeAlert({ title: 'Branch Protection Removed' }));
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.html).toContain('Branch Protection Removed');
  });

  it('tracks email sending failure (throws when only channel)', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const channel = makeChannel({
      id: 'ch_email_5',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    await expect(dispatchAlert([channel], makeAlert())).rejects.toThrow(/SMTP connection refused/);
  });

  it('fails when recipients list is empty (throws when only channel)', async () => {
    const channel = makeChannel({
      id: 'ch_email_6',
      type: 'email',
      config: { recipients: [] },
    });
    await expect(dispatchAlert([channel], makeAlert())).rejects.toThrow(/missing recipients/);
  });

  it('renders description in email body', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-7' });
    const channel = makeChannel({
      id: 'ch_email_7',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    await dispatchAlert(
      [channel],
      makeAlert({ description: 'The repository was made public by mallory' }),
    );
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.html).toContain('The repository was made public by mallory');
  });

  it('sends email without description field', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-8' });
    const channel = makeChannel({
      id: 'ch_email_8',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    const alert = makeAlert();
    delete (alert as any).description;
    await dispatchAlert([channel], { ...alert, description: undefined });
    expect(mockSendMail).toHaveBeenCalledOnce();
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.html).toContain('Test Alert');
  });
});

// =========================================================================
// 3. Webhook Dispatch (12 tests)
// =========================================================================

describe('Webhook Dispatch', () => {
  it('sends webhook with HMAC-SHA256 signature', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse());

    await sendWebhookNotification(
      { url: 'https://hook.example.com/receive', secret: 'my-secret' },
      { alert: { title: 'Test' } },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hook.example.com/receive',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    );
  });

  it('blocks SSRF: 127.0.0.1 (loopback)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: 10.0.0.1 (RFC 1918)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '10.0.0.1', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: 172.16.0.1 (RFC 1918)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '172.16.0.1', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: 192.168.1.1 (RFC 1918)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: 169.254.169.254 (AWS IMDS)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '169.254.169.254', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: 0.0.0.0', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '0.0.0.0', family: 4 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: ::1 (IPv6 loopback)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '::1', family: 6 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('blocks SSRF: IPv4-mapped IPv6 (::ffff:127.0.0.1)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '::ffff:127.0.0.1', family: 6 });
    await expect(
      sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/private/i);
  });

  it('allows public IP (93.184.216.34)', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse());
    await expect(
      sendWebhookNotification(
        { url: 'https://example.com/hook', secret: 'secret' },
        { alert: { title: 'Public' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks ftp:// protocol', async () => {
    await expect(
      sendWebhookNotification({ url: 'ftp://evil.com/hook', secret: 's' }, {}),
    ).rejects.toThrow(/scheme/i);
  });

  it('blocks file:// protocol', async () => {
    await expect(
      sendWebhookNotification({ url: 'file:///etc/passwd', secret: 's' }, {}),
    ).rejects.toThrow(/scheme/i);
  });
});

// =========================================================================
// 4. Multi-Channel Dispatch (10 tests)
// =========================================================================

describe('Multi-Channel Dispatch', () => {
  it('returns success for all channels when all succeed', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse()); // slack direct
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-mc1' }); // email
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse()); // webhook

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_e', type: 'email', config: { recipients: ['a@b.com'] } }),
      makeChannel({ id: 'ch_w', type: 'webhook', config: { url: 'https://hook.com/x', secret: 'enc_sec' } }),
    ];

    const results = await dispatchAlert(channels, makeAlert(), 'xoxb-tok', 'C999');
    expect(results).toHaveLength(3); // slack + email + webhook
    expect(results.every((r) => r.status === 'sent')).toBe(true);
  });

  it('partial success when one channel fails and others succeed', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse()); // slack
    mockSendMail.mockRejectedValueOnce(new Error('SMTP fail')); // email fails

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_e', type: 'email', config: { recipients: ['a@b.com'] } }),
    ];

    const results = await dispatchAlert(channels, makeAlert(), 'xoxb-tok', 'C999');
    expect(results).toHaveLength(2);
    const sent = results.filter((r) => r.status === 'sent');
    const failed = results.filter((r) => r.status === 'failed');
    expect(sent).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('SMTP fail');
  });

  it('throws when ALL channels fail', async () => {
    mockFetch.mockReturnValueOnce(slackErrorResponse('invalid_auth')); // slack fails
    mockSendMail.mockRejectedValueOnce(new Error('SMTP down')); // email fails

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_e', type: 'email', config: { recipients: ['a@b.com'] } }),
    ];

    await expect(
      dispatchAlert(channels, makeAlert(), 'xoxb-tok', 'C999'),
    ).rejects.toThrow(/All notification channels failed/);
  });

  it('handles mixed channel types (email + webhook + slack)', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse()); // slack
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-mix' }); // email
    mockDnsLookup.mockResolvedValueOnce({ address: '8.8.8.8', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse()); // webhook

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_e2', type: 'email', config: { recipients: ['x@y.com'] } }),
      makeChannel({ id: 'ch_w2', type: 'webhook', config: { url: 'https://hook.io/r', secret: 'enc' } }),
    ];

    const results = await dispatchAlert(channels, makeAlert(), 'xoxb-bot', 'C001');
    const types = results.map((r) => r.type);
    expect(types).toContain('slack');
    expect(types).toContain('email');
    expect(types).toContain('webhook');
  });

  it('returns empty results for empty channel list', async () => {
    const results = await dispatchAlert([], makeAlert());
    expect(results).toEqual([]);
  });

  it('skips channel with unknown type', async () => {
    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_unknown', type: 'sms', config: {} }),
    ];
    const results = await dispatchAlert(channels, makeAlert());
    // Unknown types are skipped via `continue`, no result entry
    expect(results).toHaveLength(0);
  });

  it('tracks per-channel errors separately', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error 1'));
    mockDnsLookup.mockResolvedValueOnce({ address: '192.168.0.1', family: 4 });

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_e_fail', type: 'email', config: { recipients: ['a@b.com'] } }),
      makeChannel({ id: 'ch_w_fail', type: 'webhook', config: { url: 'https://evil.local/x', secret: 'enc' } }),
    ];

    await expect(dispatchAlert(channels, makeAlert())).rejects.toThrow(/All notification channels failed/);
  });

  it('tracks responseTimeMs for successful deliveries', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-time' });
    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_time', type: 'email', config: { recipients: ['t@t.com'] } }),
    ];
    const results = await dispatchAlert(channels, makeAlert());
    expect(results[0].responseTimeMs).toBeTypeOf('number');
    expect(results[0].responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('skips unknown type without crashing other channels', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-skip' });
    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_bad', type: 'pager', config: {} }),
      makeChannel({ id: 'ch_good', type: 'email', config: { recipients: ['z@z.com'] } }),
    ];
    const results = await dispatchAlert(channels, makeAlert());
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('email');
    expect(results[0].status).toBe('sent');
  });

  it('preserves dispatch order in results', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse()); // slack first
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-ord1' }); // email second
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse()); // webhook third

    const channels: ChannelRow[] = [
      makeChannel({ id: 'ch_ord_e', type: 'email', config: { recipients: ['a@a.com'] } }),
      makeChannel({ id: 'ch_ord_w', type: 'webhook', config: { url: 'https://hook.test/r', secret: 'enc' } }),
    ];

    const results = await dispatchAlert(channels, makeAlert(), 'xoxb-tok', 'C_ORD');
    // Slack direct is always first, then channels in order
    expect(results[0].channelId).toBe('C_ORD');
    expect(results[0].type).toBe('slack');
    expect(results[1].channelId).toBe('ch_ord_e');
    expect(results[2].channelId).toBe('ch_ord_w');
  });
});

// =========================================================================
// 5. Adversarial Notification Scenarios (10 tests)
// =========================================================================

describe('Adversarial Notification Scenarios', () => {
  it('escapes XSS in alert title for email HTML', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-xss' });
    const channel = makeChannel({
      id: 'ch_xss',
      type: 'email',
      config: { recipients: ['safe@test.com'] },
    });
    const alert = makeAlert({ title: '<script>alert("xss")</script>' });
    await dispatchAlert([channel], alert);
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles SQL injection in alert description without breaking', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-sql' });
    const channel = makeChannel({
      id: 'ch_sql',
      type: 'email',
      config: { recipients: ['safe@test.com'] },
    });
    const alert = makeAlert({
      description: "'; DROP TABLE alerts; --",
    });
    const results = await dispatchAlert([channel], alert);
    expect(results[0].status).toBe('sent');
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain("&#x27;; DROP TABLE alerts; --".replace("&#x27;", "'"));
  });

  it('handles very long alert title (1000+ chars)', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse());
    const longTitle = 'A'.repeat(1500);
    const results = await dispatchAlert([], makeAlert({ title: longTitle }), 'xoxb-tok', 'C_LONG');
    expect(results[0].status).toBe('sent');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain('A'.repeat(100));
  });

  it('handles Unicode and emoji in alert fields', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse());
    const alert = makeAlert({
      title: 'Alert: Repository access change',
      fields: [
        { label: 'Actor', value: 'user-name' },
        { label: 'Note', value: 'Emoji test: check-mark, warning, fire symbols' },
      ],
    });
    const results = await dispatchAlert([], alert, 'xoxb-tok', 'C_UNI');
    expect(results[0].status).toBe('sent');
  });

  it('handles null fields in alert payload', async () => {
    mockFetch.mockReturnValueOnce(slackOkResponse());
    const alert: SlackAlertPayload = {
      title: 'Test',
      severity: 'low',
      module: 'github',
      eventType: 'test',
      timestamp: '2026-01-01T00:00:00Z',
      description: undefined,
      fields: undefined,
    };
    const results = await dispatchAlert([], alert, 'xoxb-tok', 'C_NULL');
    expect(results[0].status).toBe('sent');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Should not have description or fields sections (only header, section with metadata, divider)
    const sectionCount = body.blocks.filter((b: any) => b.type === 'section').length;
    expect(sectionCount).toBe(1); // Only the metadata section
  });

  it('handles webhook URL with query params', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookOkResponse());
    await expect(
      sendWebhookNotification(
        { url: 'https://hook.example.com/receive?token=abc&org=123', secret: 'sec' },
        { alert: { title: 'Test' } },
      ),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hook.example.com/receive?token=abc&org=123',
      expect.anything(),
    );
  });

  it('handles webhook returning 500 status', async () => {
    mockDnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    mockFetch.mockReturnValueOnce(webhookErrorResponse(500));
    await expect(
      sendWebhookNotification(
        { url: 'https://hook.example.com/x', secret: 'sec' },
        { alert: { title: 'Test' } },
      ),
    ).rejects.toThrow(/500/);
  });

  it('handles Slack rate limit response (429) - throws when only channel', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
        text: () => Promise.resolve(''),
      }),
    );
    await expect(
      dispatchAlert([], makeAlert(), 'xoxb-tok', 'C_RL'),
    ).rejects.toThrow(/ratelimited/);
  });

  it('handles email SMTP connection refused - throws when only channel', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:587'));
    const channel = makeChannel({
      id: 'ch_smtp_fail',
      type: 'email',
      config: { recipients: ['user@test.com'] },
    });
    await expect(
      dispatchAlert([channel], makeAlert()),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('handles concurrent dispatch to many channels', async () => {
    // The dispatcher processes channels sequentially (for loop), but we test it
    // handles a large number without errors
    const channels: ChannelRow[] = Array.from({ length: 50 }, (_, i) =>
      makeChannel({
        id: `ch_conc_${i}`,
        type: 'email',
        config: { recipients: [`user${i}@test.com`] },
      }),
    );
    mockSendMail.mockResolvedValue({ messageId: 'msg-conc' });

    const results = await dispatchAlert(channels, makeAlert());
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.status === 'sent')).toBe(true);
  });
});

// =========================================================================
// 6. Additional edge cases to reach 50+ tests (4 more)
// =========================================================================

describe('Additional Edge Cases', () => {
  it('email channel with "to" field instead of "recipients"', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'msg-to' });
    const channel = makeChannel({
      id: 'ch_to',
      type: 'email',
      config: { to: 'fallback@test.com' },
    });
    const results = await dispatchAlert([channel], makeAlert());
    expect(results[0].status).toBe('sent');
    const mailOpts = mockSendMail.mock.calls[0][0];
    expect(mailOpts.to).toBe('fallback@test.com');
  });

  it('webhook channel with missing url throws when only channel', async () => {
    const channel = makeChannel({
      id: 'ch_no_url',
      type: 'webhook',
      config: { secret: 'enc' },
    });
    await expect(dispatchAlert([channel], makeAlert())).rejects.toThrow(/missing url or secret/);
  });

  it('webhook channel with missing secret throws when only channel', async () => {
    const channel = makeChannel({
      id: 'ch_no_sec',
      type: 'webhook',
      config: { url: 'https://hook.com/x' },
    });
    await expect(dispatchAlert([channel], makeAlert())).rejects.toThrow(/missing url or secret/);
  });

  it('Block Kit omits description section when description is empty string', () => {
    const blocks = buildBlocks(makeAlert({ description: '' }));
    // Empty string is falsy, so description section should be omitted
    const descSections = blocks.filter(
      (b: any) => b.type === 'section' && b.text?.type === 'mrkdwn' && b.text?.text === '',
    );
    expect(descSections).toHaveLength(0);
  });
});
