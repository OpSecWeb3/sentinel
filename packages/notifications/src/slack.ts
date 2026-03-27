/**
 * Slack notification delivery via Bot API (chat.postMessage).
 * Block Kit formatting with severity badges.
 * Ported from ChainAlert.
 */

export interface SlackAlertPayload {
  title: string;
  severity: string;
  description?: string;
  module: string;
  eventType: string;
  fields?: Array<{ label: string; value: string }>;
  timestamp: string;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: ':rotating_light:',
  high: ':red_circle:',
  medium: ':large_orange_circle:',
  low: ':white_circle:',
};

export function buildBlocks(alert: SlackAlertPayload): object[] {
  const badge = SEVERITY_BADGE[alert.severity] ?? ':bell:';
  const sevLabel = alert.severity.toUpperCase();

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${badge} ${alert.title}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${badge} ${sevLabel}` },
        { type: 'mrkdwn', text: `*Module:*\n${alert.module}` },
        { type: 'mrkdwn', text: `*Event:*\n${alert.eventType}` },
        { type: 'mrkdwn', text: `*Time:*\n${alert.timestamp}` },
      ],
    },
  ];

  if (alert.description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: alert.description },
    });
  }

  if (alert.fields?.length) {
    const text = alert.fields.map((f) => `*${f.label}:* ${f.value}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  blocks.push({ type: 'divider' });
  return blocks;
}

export async function sendSlackMessage(
  botToken: string,
  channelId: string,
  alert: SlackAlertPayload,
  formatBlocks?: (alert: SlackAlertPayload) => object[],
): Promise<void> {
  const blocks = formatBlocks ? formatBlocks(alert) : buildBlocks(alert);
  const body = JSON.stringify({
    channel: channelId,
    blocks,
    text: `${alert.title} — ${alert.severity} severity`,
  });

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body,
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error ?? 'unknown'}`);
  }
}
