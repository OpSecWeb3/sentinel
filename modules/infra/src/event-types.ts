import type { EventTypeDefinition } from '@sentinel/shared/module';

export const eventTypes: EventTypeDefinition[] = [
  // ── Scan lifecycle ───────────────────────────────────────────────────
  {
    type: 'infra.scan.completed',
    label: 'Full scan completed',
    description: 'A full infrastructure scan (DNS, cert, TLS, headers, WHOIS) completed for a host',
  },
  {
    type: 'infra.probe.completed',
    label: 'Probe completed',
    description: 'A lightweight reachability probe completed for a host',
  },

  // ── Certificate ──────────────────────────────────────────────────────
  {
    type: 'infra.cert.expiring',
    label: 'Certificate expiring',
    description: 'A TLS certificate is approaching its expiration date',
  },
  {
    type: 'infra.cert.expired',
    label: 'Certificate expired',
    description: 'A TLS certificate has already expired',
  },
  {
    type: 'infra.cert.issue',
    label: 'Certificate issue detected',
    description: 'A certificate problem was found: chain error, self-signed, weak key, SHA-1 signature, or revocation',
  },

  // ── TLS ──────────────────────────────────────────────────────────────
  {
    type: 'infra.tls.weakness',
    label: 'TLS weakness detected',
    description: 'Legacy TLS versions enabled or weak cipher suites in use',
  },

  // ── DNS ──────────────────────────────────────────────────────────────
  {
    type: 'infra.dns.change',
    label: 'DNS record change',
    description: 'A DNS record was added, modified, or removed',
  },

  // ── HTTP Headers ─────────────────────────────────────────────────────
  {
    type: 'infra.header.missing',
    label: 'Security header missing',
    description: 'One or more required security headers are missing from HTTP responses',
  },

  // ── Reachability ─────────────────────────────────────────────────────
  {
    type: 'infra.host.unreachable',
    label: 'Host unreachable',
    description: 'A monitored host failed consecutive reachability checks',
  },
  {
    type: 'infra.host.slow',
    label: 'Host slow response',
    description: 'A monitored host responded slower than the configured threshold',
  },

  // ── Score ────────────────────────────────────────────────────────────
  {
    type: 'infra.score.degraded',
    label: 'Security score degraded',
    description: 'The infrastructure security score dropped below a threshold or by a significant amount',
  },

  // ── Discovery ────────────────────────────────────────────────────────
  {
    type: 'infra.subdomain.discovered',
    label: 'New subdomain discovered',
    description: 'A previously unknown subdomain was discovered via CT logs, VirusTotal passive DNS, or DNS enumeration',
  },

  // ── WHOIS ──────────────────────────────────────────────────────────────
  {
    type: 'infra.whois.expiring',
    label: 'Domain expiring',
    description: 'Domain registration is approaching its expiry date',
  },

  // ── Certificate Transparency ──────────────────────────────────────────
  {
    type: 'infra.ct.new_entry',
    label: 'New CT log entry',
    description: 'A new Certificate Transparency log entry was observed for a monitored domain',
  },
];
