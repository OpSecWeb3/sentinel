/**
 * AWS module — Slack Block Kit formatter.
 *
 * Field labels come from triggerData set by AWS evaluators.
 * Properties: eventName, eventSource, awsRegion, principalId, userArn,
 * sourceIp, errorCode, accountId, instanceId, action, mfaUsed, etc.
 */
import type { SlackAlertFields as SlackAlertPayload } from '@sentinel/shared/module';

function getField(fields: Array<{ label: string; value: string }> | undefined, label: string): string | undefined {
  return fields?.find((f) => f.label === label)?.value;
}

export function formatSlackBlocks(alert: SlackAlertPayload): object[] {
  const blocks: object[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: alert.title, emoji: false },
  });

  // Common fields across AWS evaluators
  const awsRegion = getField(alert.fields, 'awsRegion');
  const sourceIp = getField(alert.fields, 'sourceIp');
  const userArn = getField(alert.fields, 'userArn');
  const principalId = getField(alert.fields, 'principalId');
  const eventName = getField(alert.fields, 'eventName');
  const eventSource = getField(alert.fields, 'eventSource');
  const accountId = getField(alert.fields, 'accountId');
  const errorCode = getField(alert.fields, 'errorCode');

  const meta: string[] = [`*Severity:* ${alert.severity.toUpperCase()}`];
  if (awsRegion) meta.push(`*Region:* ${awsRegion}`);
  if (sourceIp) meta.push(`*Source IP:* ${sourceIp}`);
  if (userArn) meta.push(`*Principal:* ${userArn}`);
  else if (principalId) meta.push(`*Principal:* ${principalId}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } });

  const lines: string[] = [];

  if (eventName) lines.push(`*Event:* ${eventName}`);
  if (eventSource) lines.push(`*Service:* ${eventSource}`);
  if (accountId) lines.push(`*Account:* ${accountId}`);
  if (errorCode) lines.push(`*Error:* ${errorCode}`);

  // auth-failure evaluator
  const userType = getField(alert.fields, 'userType');
  const mfaUsed = getField(alert.fields, 'mfaUsed');
  const loginResult = getField(alert.fields, 'loginResult');
  if (userType) lines.push(`*User type:* ${userType}`);
  if (mfaUsed) lines.push(`*MFA:* ${mfaUsed}`);
  if (loginResult) lines.push(`*Login result:* ${loginResult}`);

  // spot-eviction evaluator
  const instanceId = getField(alert.fields, 'instanceId');
  const action = getField(alert.fields, 'action');
  if (instanceId) lines.push(`*Instance:* ${instanceId}`);
  if (action) lines.push(`*Action:* ${action}`);

  if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });

  if (alert.description) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alert.description } });
  }

  const footerParts: string[] = [];
  if (alert.alertUrl) footerParts.push(`<${alert.alertUrl}|View Alert>`);
  footerParts.push(alert.timestamp);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footerParts.join('  |  ') }] });
  blocks.push({ type: 'divider' });
  return blocks;
}
