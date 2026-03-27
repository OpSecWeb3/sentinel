import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock global fetch so sendSlackMessage does not make real HTTP calls
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { sendSlackMessage, type SlackAlertPayload } from '../slack.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAlert(overrides: Partial<SlackAlertPayload> = {}): SlackAlertPayload {
  return {
    title: 'Test Alert',
    severity: 'high',
    module: 'github',
    eventType: 'push',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Extract blocks from the fetch call body */
function getBlocksFromCall(): any[] {
  const [, reqInit] = fetchMock.mock.calls[0];
  const body = JSON.parse(reqInit.body as string);
  return body.blocks;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
});

// ---------------------------------------------------------------------------
// Block Kit structure
// ---------------------------------------------------------------------------
describe('Slack Block Kit structure', () => {
  it('has header, section with fields, and divider', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert());
    const blocks = getBlocksFromCall();

    // First block is header
    expect(blocks[0]).toMatchObject({ type: 'header' });
    expect(blocks[0].text.type).toBe('plain_text');

    // Second block is section with fields
    expect(blocks[1]).toMatchObject({ type: 'section' });
    expect(blocks[1].fields).toBeDefined();
    expect(blocks[1].fields.length).toBeGreaterThanOrEqual(4);

    // Last block is divider
    expect(blocks[blocks.length - 1]).toMatchObject({ type: 'divider' });
  });

  it('includes description section when provided', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ description: 'Detailed info' }));
    const blocks = getBlocksFromCall();

    const descBlock = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text === 'Detailed info',
    );
    expect(descBlock).toBeDefined();
  });

  it('omits description section when not provided', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ description: undefined }));
    const blocks = getBlocksFromCall();

    // Should only have header, fields section, and divider (3 blocks)
    expect(blocks.length).toBe(3);
  });

  it('includes custom fields section when provided', async () => {
    const fields = [
      { label: 'Repo', value: 'my-org/my-repo' },
      { label: 'Branch', value: 'main' },
    ];
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ fields }));
    const blocks = getBlocksFromCall();

    const fieldsBlock = blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*Repo:*'),
    );
    expect(fieldsBlock).toBeDefined();
    expect(fieldsBlock.text.text).toContain('*Branch:* main');
  });

  it('all required fields present in section fields', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert());
    const blocks = getBlocksFromCall();
    const sectionFields = blocks[1].fields;

    const fieldTexts = sectionFields.map((f: any) => f.text);
    expect(fieldTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('*Severity:*'),
        expect.stringContaining('*Module:*'),
        expect.stringContaining('*Event:*'),
        expect.stringContaining('*Time:*'),
      ]),
    );
  });

  it('header text includes the alert title', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ title: 'Secret Leak Detected' }));
    const blocks = getBlocksFromCall();
    expect(blocks[0].text.text).toContain('Secret Leak Detected');
  });
});

// ---------------------------------------------------------------------------
// Severity badges
// ---------------------------------------------------------------------------
describe('severity badges', () => {
  const cases: Array<{ severity: string; emoji: string }> = [
    { severity: 'critical', emoji: ':rotating_light:' },
    { severity: 'high', emoji: ':red_circle:' },
    { severity: 'medium', emoji: ':large_orange_circle:' },
    { severity: 'low', emoji: ':white_circle:' },
  ];

  for (const { severity, emoji } of cases) {
    it(`maps "${severity}" to ${emoji}`, async () => {
      await sendSlackMessage('xoxb-token', 'C123', makeAlert({ severity }));
      const blocks = getBlocksFromCall();

      // Header should contain the badge emoji
      expect(blocks[0].text.text).toContain(emoji);

      // Severity field in the section should also contain it
      const sevField = blocks[1].fields.find((f: any) => f.text.includes('*Severity:*'));
      expect(sevField.text).toContain(emoji);
      expect(sevField.text).toContain(severity.toUpperCase());
    });
  }

  it('uses :bell: as fallback for unknown severity', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ severity: 'info' }));
    const blocks = getBlocksFromCall();
    expect(blocks[0].text.text).toContain(':bell:');
  });
});

// ---------------------------------------------------------------------------
// API call details
// ---------------------------------------------------------------------------
describe('Slack API call', () => {
  it('posts to chat.postMessage endpoint', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.anything(),
    );
  });

  it('sends correct Authorization header', async () => {
    await sendSlackMessage('xoxb-my-token', 'C123', makeAlert());
    const [, reqInit] = fetchMock.mock.calls[0];
    expect(reqInit.headers.Authorization).toBe('Bearer xoxb-my-token');
  });

  it('sends correct channel in body', async () => {
    await sendSlackMessage('xoxb-token', 'C999', makeAlert());
    const [, reqInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(reqInit.body as string);
    expect(body.channel).toBe('C999');
  });

  it('includes fallback text', async () => {
    await sendSlackMessage('xoxb-token', 'C123', makeAlert({ title: 'Alert X', severity: 'high' }));
    const [, reqInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(reqInit.body as string);
    expect(body.text).toContain('Alert X');
    expect(body.text).toContain('high');
  });

  it('throws on Slack API error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    await expect(
      sendSlackMessage('xoxb-token', 'C123', makeAlert()),
    ).rejects.toThrow(/channel_not_found/);
  });
});
