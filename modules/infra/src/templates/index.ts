import type { DetectionTemplate } from '@sentinel/shared/module';

export const templates: DetectionTemplate[] = [
  // ── Certificate Monitoring ───────────────────────────────────────────
  {
    slug: 'infra-cert-monitor',
    name: 'Certificate Monitor',
    description: 'Alert on expiring certificates and certificate issues (chain errors, self-signed, weak key, SHA-1, revocation).',
    category: 'certificate',
    severity: 'critical',
    inputs: [
      {
        key: 'thresholdDays',
        label: 'Alert when cert expires within (days)',
        type: 'number',
        required: false,
        default: 30,
        min: 1,
        max: 365,
        help: 'Alert when the certificate expires within this many days.',
      },
    ],
    rules: [
      {
        ruleType: 'infra.cert_expiry',
        config: { thresholdDays: 30 },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'infra.cert_issues',
        config: { issueTypes: [] },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── TLS Security ─────────────────────────────────────────────────────
  {
    slug: 'infra-tls-security',
    name: 'TLS Security',
    description: 'Alert on TLS weaknesses (legacy versions, weak ciphers) and missing security headers (HSTS, CSP, etc.).',
    category: 'tls',
    severity: 'high',
    rules: [
      {
        ruleType: 'infra.tls_weakness',
        config: {
          alertOnLegacyVersions: true,
          alertOnWeakCiphers: true,
          alertOnMissingTls13: false,
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'infra.header_missing',
        config: { requiredHeaders: [] },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── DNS Change Monitor ───────────────────────────────────────────────
  {
    slug: 'infra-dns-change-monitor',
    name: 'DNS Change Monitor',
    description: 'Alert on DNS record changes and newly discovered subdomains via CT logs or DNS enumeration.',
    category: 'dns',
    severity: 'high',
    rules: [
      {
        ruleType: 'infra.dns_change',
        config: { watchRecordTypes: [], watchChangeTypes: [] },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'infra.new_subdomain',
        config: { ignorePatterns: [] },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── Host Uptime ──────────────────────────────────────────────────────
  {
    slug: 'infra-host-uptime',
    name: 'Host Uptime',
    description: 'Alert when a host becomes unreachable or responds slowly. Requires probe scheduling to be enabled.',
    category: 'availability',
    severity: 'critical',
    inputs: [
      {
        key: 'thresholdMs',
        label: 'Response timeout (ms)',
        type: 'number',
        required: false,
        default: 5000,
        min: 500,
        max: 30000,
        help: 'Alert when a host takes longer than this to respond.',
      },
      {
        key: 'consecutiveFailures',
        label: 'Consecutive failures before alert',
        type: 'number',
        required: false,
        default: 2,
        min: 1,
        max: 10,
        help: 'Number of consecutive failed probes before triggering an alert.',
      },
    ],
    rules: [
      {
        ruleType: 'infra.host_unreachable',
        config: { thresholdMs: 5000, consecutiveFailures: 2 },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── Domain Expiry ──────────────────────────────────────────────────────
  {
    slug: 'infra-domain-expiry',
    name: 'Domain Expiry Monitor',
    description: 'Alert when a domain registration is approaching its expiry date. Prevents accidental domain loss and potential hijacking.',
    category: 'dns',
    severity: 'high',
    inputs: [
      {
        key: 'thresholdDays',
        label: 'Alert when domain expires within (days)',
        type: 'number',
        required: false,
        default: 30,
        min: 1,
        max: 365,
      },
    ],
    rules: [
      {
        ruleType: 'infra.whois_expiry',
        config: { thresholdDays: 30 },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── CT Log Monitor ─────────────────────────────────────────────────────
  {
    slug: 'infra-ct-monitor',
    name: 'Certificate Transparency Monitor',
    description: 'Alert on new Certificate Transparency log entries for your domain. Detects unauthorized certificate issuance and potential domain impersonation.',
    category: 'dns',
    severity: 'medium',
    rules: [
      {
        ruleType: 'infra.ct_new_entry',
        config: { ignorePatterns: [] },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── Full Infrastructure Audit ────────────────────────────────────────
  {
    slug: 'infra-full-audit',
    name: 'Full Infrastructure Audit',
    description: 'Enable all infrastructure security monitors in one detection. Covers certificates, TLS, DNS, headers, availability, score tracking, and subdomain discovery.',
    category: 'comprehensive',
    severity: 'critical',
    inputs: [
      {
        key: 'thresholdDays',
        label: 'Expiry warning threshold (days)',
        type: 'number',
        required: false,
        default: 30,
        min: 1,
        max: 365,
        help: 'Alert when certificates or domains expire within this many days.',
      },
    ],
    rules: [
      {
        ruleType: 'infra.cert_expiry',
        config: { thresholdDays: 30 },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'infra.cert_issues',
        config: { issueTypes: [] },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'infra.tls_weakness',
        config: {
          alertOnLegacyVersions: true,
          alertOnWeakCiphers: true,
          alertOnMissingTls13: false,
        },
        action: 'alert',
        priority: 20,
      },
      {
        ruleType: 'infra.header_missing',
        config: { requiredHeaders: [] },
        action: 'alert',
        priority: 20,
      },
      {
        ruleType: 'infra.dns_change',
        config: { watchRecordTypes: [], watchChangeTypes: [] },
        action: 'alert',
        priority: 30,
      },
      {
        ruleType: 'infra.new_subdomain',
        config: { ignorePatterns: [] },
        action: 'alert',
        priority: 30,
      },
      {
        ruleType: 'infra.whois_expiry',
        config: { thresholdDays: 30 },
        action: 'alert',
        priority: 35,
      },
      {
        ruleType: 'infra.ct_new_entry',
        config: { ignorePatterns: [] },
        action: 'alert',
        priority: 35,
      },
      {
        ruleType: 'infra.host_unreachable',
        config: { thresholdMs: 5000, consecutiveFailures: 2 },
        action: 'alert',
        priority: 40,
      },
      {
        ruleType: 'infra.score_degradation',
        config: { minScore: 70, minDrop: 10, mode: 'both' },
        action: 'alert',
        priority: 50,
      },
    ],
  },
];
