/**
 * GitHub module — Slack Block Kit formatter.
 *
 * Field labels come from triggerData which mirrors the GitHub webhook payload.
 * Nested objects are flattened as "parent.child" (e.g. "repository.full_name").
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

  // triggerData properties from GitHub evaluators
  const repo = getField(alert.fields, 'repository.full_name');
  const sender = getField(alert.fields, 'sender.login');
  const action = getField(alert.fields, 'action');
  const orgLogin = getField(alert.fields, 'organization.login');

  const meta: string[] = [`*Severity:* ${alert.severity.toUpperCase()}`];
  if (repo) meta.push(`*Repository:* ${repo}`);
  if (sender) meta.push(`*Actor:* ${sender}`);
  if (orgLogin) meta.push(`*Organization:* ${orgLogin}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } });

  const et = alert.eventType;

  if (et === 'github.repository.visibility_changed') {
    const visibility = getField(alert.fields, 'repository.visibility');
    const lines: string[] = [];
    if (visibility) lines.push(`*Visibility:* ${visibility}`);
    if (action) lines.push(`*Action:* ${action}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.startsWith('github.secret_scanning.')) {
    const secretType = getField(alert.fields, 'alert.secret_type');
    const alertNumber = getField(alert.fields, 'alert.number');
    const state = getField(alert.fields, 'alert.state');
    const lines: string[] = [];
    if (secretType) lines.push(`*Secret type:* ${secretType}`);
    if (alertNumber) lines.push(`*Alert #:* ${alertNumber}`);
    if (state) lines.push(`*State:* ${state}`);
    if (action) lines.push(`*Webhook action:* ${action}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.includes('member') || et.includes('organization.member')) {
    const member = getField(alert.fields, 'member.login') ?? getField(alert.fields, 'membership.user.login');
    const role = getField(alert.fields, 'member.role') ?? getField(alert.fields, 'membership.role');
    const lines: string[] = [];
    if (member) lines.push(`*Member:* ${member}`);
    if (role) lines.push(`*Role:* ${role}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.includes('branch_protection')) {
    const ruleName = getField(alert.fields, 'rule.name');
    const rulePattern = getField(alert.fields, 'rule.pattern');
    const lines: string[] = [];
    if (ruleName) lines.push(`*Rule:* ${ruleName}`);
    if (rulePattern) lines.push(`*Pattern:* ${rulePattern}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.includes('deploy_key')) {
    const keyTitle = getField(alert.fields, 'key.title');
    const readOnly = getField(alert.fields, 'key.read_only');
    const lines: string[] = [];
    if (keyTitle) lines.push(`*Key:* ${keyTitle}`);
    if (readOnly !== undefined) lines.push(`*Read-only:* ${readOnly}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.includes('push') || et.includes('force_push')) {
    const ref = getField(alert.fields, 'ref');
    const forced = getField(alert.fields, 'forced');
    const pusher = getField(alert.fields, 'pusher.name');
    const lines: string[] = [];
    if (ref) lines.push(`*Ref:* ${ref}`);
    if (forced) lines.push(`*Forced:* ${forced}`);
    if (pusher) lines.push(`*Pusher:* ${pusher}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et.includes('team')) {
    const teamName = getField(alert.fields, 'team.name');
    const teamPerm = getField(alert.fields, 'team.permission');
    const lines: string[] = [];
    if (teamName) lines.push(`*Team:* ${teamName}`);
    if (teamPerm) lines.push(`*Permission:* ${teamPerm}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }

  if (alert.description) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alert.description } });
  }

  // Footer
  const footerParts: string[] = [];
  if (alert.alertUrl) footerParts.push(`<${alert.alertUrl}|View Alert>`);
  footerParts.push(alert.timestamp);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footerParts.join('  |  ') }] });
  blocks.push({ type: 'divider' });
  return blocks;
}
