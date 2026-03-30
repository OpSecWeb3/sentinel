/**
 * Infrastructure module — Slack Block Kit formatter.
 *
 * Field labels come from triggerData set by infra evaluators.
 * Property names: hostname, daysRemaining, notAfter, issuer, consecutiveFailures, etc.
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

  const hostname = getField(alert.fields, 'hostname') ?? getField(alert.fields, 'parentHostname');

  const meta: string[] = [`*Severity:* ${alert.severity.toUpperCase()}`];
  if (hostname) meta.push(`*Host:* ${hostname}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } });

  const et = alert.eventType;

  if (et === 'infra.cert.expiring' || et === 'infra.cert.expired') {
    const daysRemaining = getField(alert.fields, 'daysRemaining');
    const notAfter = getField(alert.fields, 'notAfter');
    const subject = getField(alert.fields, 'subject');
    const lines: string[] = [];
    if (daysRemaining) lines.push(`*Days remaining:* ${daysRemaining}`);
    if (notAfter) lines.push(`*Expires:* ${notAfter}`);
    if (subject) lines.push(`*Subject:* ${subject}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.cert.issue') {
    const issueType = getField(alert.fields, 'issueType');
    const detail = getField(alert.fields, 'detail');
    const issuer = getField(alert.fields, 'issuer');
    const subject = getField(alert.fields, 'subject');
    const lines: string[] = [];
    if (issueType) lines.push(`*Issue:* ${issueType}`);
    if (detail) lines.push(`*Detail:* ${detail}`);
    if (issuer) lines.push(`*Issuer:* ${issuer}`);
    if (subject) lines.push(`*Subject:* ${subject}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.host.unreachable') {
    const consecutiveFailures = getField(alert.fields, 'consecutiveFailures');
    const errorMessage = getField(alert.fields, 'errorMessage');
    const httpStatus = getField(alert.fields, 'httpStatus');
    const lines: string[] = [];
    if (consecutiveFailures) lines.push(`*Consecutive failures:* ${consecutiveFailures}`);
    if (httpStatus) lines.push(`*HTTP status:* ${httpStatus}`);
    if (errorMessage) lines.push(`*Error:* ${errorMessage}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.host.slow') {
    const responseTimeMs = getField(alert.fields, 'responseTimeMs');
    const lines: string[] = [];
    if (responseTimeMs) lines.push(`*Response time:* ${responseTimeMs}ms`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.dns.change') {
    // dns-change evaluator spreads payload + changes array; individual change fields
    // won't be flattened since changes is an array. Show what we have.
    const lines: string[] = [];
    // The flattener skips arrays, but description should carry the summary
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.score.degraded') {
    const currentScore = getField(alert.fields, 'currentScore');
    const previousScore = getField(alert.fields, 'previousScore');
    const grade = getField(alert.fields, 'grade');
    const lines: string[] = [];
    if (previousScore && currentScore) lines.push(`*Score:* ${previousScore} → ${currentScore}`);
    else if (currentScore) lines.push(`*Score:* ${currentScore}`);
    if (grade) lines.push(`*Grade:* ${grade}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.tls.weakness') {
    const legacyVersions = getField(alert.fields, 'legacyVersions');
    const hasWeakCiphers = getField(alert.fields, 'hasWeakCiphers');
    const lines: string[] = [];
    if (legacyVersions) lines.push(`*Legacy versions:* ${legacyVersions}`);
    if (hasWeakCiphers === 'true') lines.push(`*Weak ciphers:* yes`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.subdomain.discovered') {
    const subdomain = getField(alert.fields, 'subdomain');
    const source = getField(alert.fields, 'source');
    const lines: string[] = [];
    if (subdomain) lines.push(`*Subdomain:* ${subdomain}`);
    if (source) lines.push(`*Source:* ${source}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.header.missing') {
    // missingHeaders is an array, won't be flattened — description carries it
  } else if (et === 'infra.whois.expiring') {
    const daysRemaining = getField(alert.fields, 'daysRemaining');
    const expiryDate = getField(alert.fields, 'expiryDate');
    const registrar = getField(alert.fields, 'registrar');
    const lines: string[] = [];
    if (daysRemaining) lines.push(`*Days remaining:* ${daysRemaining}`);
    if (expiryDate) lines.push(`*Expiry:* ${expiryDate}`);
    if (registrar) lines.push(`*Registrar:* ${registrar}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  } else if (et === 'infra.ct.new_entry') {
    const issuerName = getField(alert.fields, 'issuerName');
    const commonName = getField(alert.fields, 'commonName');
    const nameValue = getField(alert.fields, 'nameValue');
    const lines: string[] = [];
    if (commonName) lines.push(`*Common name:* ${commonName}`);
    if (nameValue) lines.push(`*SAN:* ${nameValue}`);
    if (issuerName) lines.push(`*Issuer:* ${issuerName}`);
    if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }

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
