#!/usr/bin/env npx tsx
/**
 * Preview Slack alert formatters using realistic triggerData field names.
 *
 * Usage:
 *   npx tsx scripts/preview-slack-alerts.ts <webhook-url>
 */

import { formatSlackBlocks as githubFormatter } from '../modules/github/src/slack-formatter.js';
import { formatSlackBlocks as infraFormatter } from '../modules/infra/src/slack-formatter.js';
import { formatSlackBlocks as chainFormatter } from '../modules/chain/src/slack-formatter.js';
import { formatSlackBlocks as registryFormatter } from '../modules/registry/src/slack-formatter.js';
import { formatSlackBlocks as awsFormatter } from '../modules/aws/src/slack-formatter.js';
import type { SlackAlertFields as SlackAlertPayload } from '../packages/shared/src/module.js';

const now = new Date().toISOString();
const ALERT_BASE = 'https://app.sentinel.example.com/alerts';
let alertCounter = 1000;
function sampleUrl(): string { return `${ALERT_BASE}/${++alertCounter}`; }

interface Sample {
  label: string;
  formatter: (alert: SlackAlertPayload) => object[];
  payload: SlackAlertPayload;
}

const samples: Sample[] = [
  // ── GitHub (triggerData = GitHub webhook payload) ─────────────────────
  {
    label: 'GitHub: Repo made public',
    formatter: githubFormatter,
    payload: {
      title: 'Repository visibility changed',
      severity: 'critical',
      module: 'github',
      eventType: 'github.repository.visibility_changed',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'action', value: 'publicized' },
        { label: 'repository.full_name', value: 'acme-corp/internal-api' },
        { label: 'repository.visibility', value: 'public' },
        { label: 'sender.login', value: 'jmaldonado' },
      ],
    },
  },
  {
    label: 'GitHub: Secret scanning alert',
    formatter: githubFormatter,
    payload: {
      title: 'Secret scanning alert created',
      severity: 'high',
      module: 'github',
      eventType: 'github.secret_scanning.created',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'action', value: 'created' },
        { label: 'alert.secret_type', value: 'stripe_api_key' },
        { label: 'alert.number', value: '42' },
        { label: 'alert.state', value: 'open' },
        { label: 'repository.full_name', value: 'acme-corp/payments-service' },
        { label: 'sender.login', value: 'dependabot[bot]' },
      ],
    },
  },
  {
    label: 'GitHub: Member added',
    formatter: githubFormatter,
    payload: {
      title: 'Organization member added',
      severity: 'medium',
      module: 'github',
      eventType: 'github.organization.member_added',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'action', value: 'member_added' },
        { label: 'member.login', value: 'new-contractor-42' },
        { label: 'member.role', value: 'admin' },
        { label: 'organization.login', value: 'acme-corp' },
        { label: 'sender.login', value: 'cto-jane' },
      ],
    },
  },

  // ── Infra (triggerData = evaluator payload objects) ──────────────────
  {
    label: 'Infra: Cert expiring (5 days)',
    formatter: infraFormatter,
    payload: {
      title: 'Certificate expiring soon',
      severity: 'high',
      module: 'infra',
      eventType: 'infra.cert.expiring',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'hostname', value: 'api.acme-corp.com' },
        { label: 'daysRemaining', value: '5' },
        { label: 'notAfter', value: '2026-04-04T12:00:00Z' },
        { label: 'subject', value: 'CN=api.acme-corp.com' },
      ],
    },
  },
  {
    label: 'Infra: Host unreachable',
    formatter: infraFormatter,
    payload: {
      title: 'Host unreachable',
      severity: 'critical',
      module: 'infra',
      eventType: 'infra.host.unreachable',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'hostname', value: 'dashboard.acme-corp.com' },
        { label: 'consecutiveFailures', value: '12' },
        { label: 'isReachable', value: 'false' },
        { label: 'errorMessage', value: 'ECONNREFUSED' },
      ],
    },
  },
  {
    label: 'Infra: Score degraded',
    formatter: infraFormatter,
    payload: {
      title: 'Security score degraded',
      severity: 'medium',
      module: 'infra',
      eventType: 'infra.score.degraded',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'hostname', value: 'acme-corp.com' },
        { label: 'currentScore', value: '62' },
        { label: 'previousScore', value: '85' },
        { label: 'grade', value: 'D' },
      ],
    },
  },

  // ── Chain (triggerData = structured evaluator objects) ────────────────
  {
    label: 'Chain: Event match (large transfer)',
    formatter: chainFormatter,
    payload: {
      title: 'Large transfer detected',
      severity: 'high',
      module: 'chain',
      eventType: 'chain.event.matched',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'type', value: 'event-match' },
        { label: 'network', value: 'Ethereum Mainnet' },
        { label: 'eventName', value: 'Transfer' },
        { label: 'contractAddress', value: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        { label: 'transactionHash', value: '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' },
        { label: 'blockNumber', value: '19842156' },
      ],
    },
  },
  {
    label: 'Chain: Balance drop',
    formatter: chainFormatter,
    payload: {
      title: 'Significant balance change',
      severity: 'critical',
      module: 'chain',
      eventType: 'chain.state.balance_change',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'type', value: 'balance-track' },
        { label: 'network', value: 'Ethereum Mainnet' },
        { label: 'address', value: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' },
        { label: 'conditionType', value: 'percent_drop' },
        { label: 'currentValue', value: '420000' },
        { label: 'previousValue', value: '8420000' },
        { label: 'percentChange', value: '-95.01' },
        { label: 'direction', value: 'drop' },
        { label: 'blockNumber', value: '19842200' },
      ],
    },
  },
  {
    label: 'Chain: Ownership change (Polygon)',
    formatter: chainFormatter,
    payload: {
      title: 'Ownership transferred',
      severity: 'critical',
      module: 'chain',
      eventType: 'chain.event.matched',
      timestamp: now,
      alertUrl: sampleUrl(),
      description: 'OwnershipTransferred event detected.',
      fields: [
        { label: 'type', value: 'event-match' },
        { label: 'network', value: 'Polygon' },
        { label: 'eventName', value: 'OwnershipTransferred' },
        { label: 'contractAddress', value: '0x1234567890abcdef1234567890abcdef12345678' },
        { label: 'transactionHash', value: '0xf1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e' },
        { label: 'blockNumber', value: '54321000' },
      ],
    },
  },

  // ── Registry (triggerData = event.payload from registry evaluators) ──
  {
    label: 'Registry: Docker digest change',
    formatter: registryFormatter,
    payload: {
      title: 'Docker image digest changed',
      severity: 'high',
      module: 'registry',
      eventType: 'registry.docker.digest_change',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'artifact', value: 'ghcr.io/acme-corp/api-server' },
        { label: 'tag', value: 'v2.4.1' },
        { label: 'eventType', value: 'digest_change' },
        { label: 'oldDigest', value: 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' },
        { label: 'newDigest', value: 'sha256:9f8e7d6c5b4a9f8e7d6c5b4a9f8e7d6c5b4a9f8e7d6c5b4a9f8e7d6c5b4a9f8e' },
        { label: 'source', value: 'webhook' },
        { label: 'pusher', value: 'github-actions[bot]' },
      ],
    },
  },
  {
    label: 'Registry: npm maintainer changed',
    formatter: registryFormatter,
    payload: {
      title: 'npm maintainer changed',
      severity: 'high',
      module: 'registry',
      eventType: 'registry.npm.maintainer_changed',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'artifact', value: '@acme-corp/auth-sdk' },
        { label: 'tag', value: 'latest' },
        { label: 'eventType', value: 'maintainer_changed' },
        { label: 'source', value: 'poll' },
        { label: 'maintainers.added', value: 'unknown-user-99' },
        { label: 'maintainers.removed', value: 'trusted-maintainer' },
      ],
    },
  },
  {
    label: 'Registry: Provenance missing',
    formatter: registryFormatter,
    payload: {
      title: 'SLSA provenance missing',
      severity: 'medium',
      module: 'registry',
      eventType: 'registry.verification.provenance_missing',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'artifact', value: 'ghcr.io/acme-corp/worker' },
        { label: 'tag', value: 'v1.8.0' },
        { label: 'newDigest', value: 'sha256:deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678' },
        { label: 'verification.provenance.hasProvenance', value: 'false' },
      ],
    },
  },

  // ── AWS (triggerData = handpicked CloudTrail fields) ─────────────────
  {
    label: 'AWS: CloudTrail stopped',
    formatter: awsFormatter,
    payload: {
      title: 'CloudTrail logging stopped',
      severity: 'critical',
      module: 'aws',
      eventType: 'aws.cloudtrail.StopLogging',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'eventName', value: 'StopLogging' },
        { label: 'eventSource', value: 'cloudtrail.amazonaws.com' },
        { label: 'awsRegion', value: 'us-east-1' },
        { label: 'principalId', value: 'AIDA1234567890EXAMPLE' },
        { label: 'userArn', value: 'arn:aws:iam::123456789012:user/suspicious-admin' },
        { label: 'sourceIp', value: '198.51.100.42' },
        { label: 'accountId', value: '123456789012' },
      ],
    },
  },
  {
    label: 'AWS: IAM access key created',
    formatter: awsFormatter,
    payload: {
      title: 'IAM access key created',
      severity: 'high',
      module: 'aws',
      eventType: 'aws.iam.CreateAccessKey',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'eventName', value: 'CreateAccessKey' },
        { label: 'eventSource', value: 'iam.amazonaws.com' },
        { label: 'awsRegion', value: 'us-east-1' },
        { label: 'principalId', value: 'AIDA0987654321EXAMPLE' },
        { label: 'userArn', value: 'arn:aws:iam::123456789012:user/ops-admin' },
        { label: 'sourceIp', value: '203.0.113.17' },
        { label: 'accountId', value: '123456789012' },
      ],
    },
  },
  {
    label: 'AWS: Console login without MFA',
    formatter: awsFormatter,
    payload: {
      title: 'Console login without MFA',
      severity: 'high',
      module: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      timestamp: now,
      alertUrl: sampleUrl(),
      fields: [
        { label: 'userType', value: 'IAMUser' },
        { label: 'userArn', value: 'arn:aws:iam::123456789012:user/dev-intern' },
        { label: 'sourceIp', value: '10.0.1.50' },
        { label: 'awsRegion', value: 'eu-west-1' },
        { label: 'mfaUsed', value: 'No' },
        { label: 'loginResult', value: 'Success' },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
async function main() {
  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    console.error('Usage: npx tsx scripts/preview-slack-alerts.ts <webhook-url>');
    process.exit(1);
  }

  console.log(`Sending ${samples.length} sample alerts to ${webhookUrl}\n`);

  for (const sample of samples) {
    const blocks = sample.formatter(sample.payload);
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks, text: `${sample.payload.title} — ${sample.payload.severity}` }),
    });
    const status = res.ok ? 'OK' : `FAIL (${res.status})`;
    console.log(`  [${status}] ${sample.label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
