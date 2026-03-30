/**
 * Registry module — Slack Block Kit formatter.
 *
 * Field labels come from triggerData which is event.payload from registry evaluators.
 * Properties: artifact, tag, eventType, oldDigest, newDigest, source, pusher,
 * maintainers.added, maintainers.removed, attribution.status, metadata.hasInstallScripts, etc.
 */
import type { SlackAlertFields as SlackAlertPayload } from '@sentinel/shared/module';

function getField(fields: Array<{ label: string; value: string }> | undefined, label: string): string | undefined {
  return fields?.find((f) => f.label === label)?.value;
}

function truncateDigest(d: string): string {
  if (d.length <= 20) return d;
  const colonIdx = d.indexOf(':');
  if (colonIdx > 0) return `${d.slice(0, colonIdx + 9)}...${d.slice(-6)}`;
  return `${d.slice(0, 12)}...${d.slice(-6)}`;
}

export function formatSlackBlocks(alert: SlackAlertPayload): object[] {
  const blocks: object[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: alert.title, emoji: false },
  });

  const artifact = getField(alert.fields, 'artifact');
  const tag = getField(alert.fields, 'tag');

  const meta: string[] = [`*Severity:* ${alert.severity.toUpperCase()}`];
  if (artifact) meta.push(`*Artifact:* ${artifact}${tag ? `:${tag}` : ''}`);
  else if (tag) meta.push(`*Tag:* ${tag}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } });

  const et = alert.eventType;
  const lines: string[] = [];

  // Digest info (digest-change evaluator)
  const oldDigest = getField(alert.fields, 'oldDigest');
  const newDigest = getField(alert.fields, 'newDigest');
  if (oldDigest) lines.push(`*Old digest:* ${truncateDigest(oldDigest)}`);
  if (newDigest) lines.push(`*New digest:* ${truncateDigest(newDigest)}`);

  // Source and pusher (digest-change, anomaly-detection evaluators)
  const source = getField(alert.fields, 'source');
  const pusher = getField(alert.fields, 'pusher');
  if (source) lines.push(`*Source:* ${source}`);
  if (pusher) lines.push(`*Pusher:* ${pusher}`);

  // Maintainer changes (digest-change evaluator, nested)
  const maintainersAdded = getField(alert.fields, 'maintainers.added');
  const maintainersRemoved = getField(alert.fields, 'maintainers.removed');
  if (maintainersAdded) lines.push(`*Maintainers added:* ${maintainersAdded}`);
  if (maintainersRemoved) lines.push(`*Maintainers removed:* ${maintainersRemoved}`);

  // Attribution (attribution evaluator, nested)
  const attrStatus = getField(alert.fields, 'attribution.status');
  const attrWorkflow = getField(alert.fields, 'attribution.workflow');
  const attrActor = getField(alert.fields, 'attribution.actor');
  const attrBranch = getField(alert.fields, 'attribution.branch');
  if (attrStatus) lines.push(`*Attribution:* ${attrStatus}`);
  if (attrWorkflow) lines.push(`*Workflow:* ${attrWorkflow}`);
  if (attrActor) lines.push(`*CI actor:* ${attrActor}`);
  if (attrBranch) lines.push(`*Branch:* ${attrBranch}`);

  // Verification (security-policy evaluator, nested)
  const hasSig = getField(alert.fields, 'verification.signature.hasSignature');
  const hasProv = getField(alert.fields, 'verification.provenance.hasProvenance');
  if (hasSig !== undefined) lines.push(`*Signature:* ${hasSig === 'true' ? 'present' : 'missing'}`);
  if (hasProv !== undefined) lines.push(`*Provenance:* ${hasProv === 'true' ? 'present' : 'missing'}`);

  // npm metadata (npm-checks evaluator, nested)
  const hasInstallScripts = getField(alert.fields, 'metadata.hasInstallScripts');
  const isMajorJump = getField(alert.fields, 'metadata.isMajorVersionJump');
  const previousVersion = getField(alert.fields, 'metadata.previousVersion');
  if (hasInstallScripts === 'true') lines.push(`*Install scripts:* yes`);
  if (isMajorJump === 'true') lines.push(`*Major version jump:* yes`);
  if (previousVersion) lines.push(`*Previous version:* ${previousVersion}`);

  // Rate limit (anomaly-detection evaluator)
  const rateCount = getField(alert.fields, 'rateLimit.count');
  const rateMax = getField(alert.fields, 'rateLimit.maxChanges');
  const rateWindow = getField(alert.fields, 'rateLimit.windowMinutes');
  if (rateCount) lines.push(`*Changes:* ${rateCount}${rateMax ? ` / ${rateMax}` : ''}${rateWindow ? ` in ${rateWindow}m` : ''}`);

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
