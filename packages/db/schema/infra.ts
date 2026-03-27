import {
  pgTable, text, uuid, timestamp, boolean, jsonb, integer,
  real, bigint, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Hosts — root domains & subdomains being monitored
// ---------------------------------------------------------------------------

export const infraHosts = pgTable('infra_hosts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): any => infraHosts.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  isRoot: boolean('is_root').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  source: text('source').notNull().default('manual'), // manual, crt_sh, brute_force, dns_zone

  // Current state (denormalized for fast reads)
  currentScore: integer('current_score'),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_hosts_org_hostname').on(t.orgId, t.hostname),
  index('idx_infra_hosts_org_parent').on(t.orgId, t.parentId),
  index('idx_infra_hosts_org_root').on(t.orgId, t.isRoot),
]);

// ---------------------------------------------------------------------------
// Infrastructure snapshots — IP, geo, cloud provider, ASN, reverse DNS
// ---------------------------------------------------------------------------

export const infraSnapshots = pgTable('infra_snapshots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  ipAddress: text('ip_address').notNull(),            // IPv4 or IPv6
  ipVersion: integer('ip_version').notNull(),         // 4 or 6
  geoCountry: text('geo_country'),
  geoCity: text('geo_city'),
  geoLat: real('geo_lat'),
  geoLon: real('geo_lon'),
  cloudProvider: text('cloud_provider'),              // aws, gcp, azure, cloudflare, etc.
  reverseDnsName: text('reverse_dns_name'),
  openPorts: jsonb('open_ports').notNull().default([]),
  asn: text('asn'),
  asnOrg: text('asn_org'),

  scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_snapshots_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// Certificates — TLS certificates observed on hosts
// ---------------------------------------------------------------------------

export const infraCertificates = pgTable('infra_certificates', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  serialNumber: text('serial_number').notNull(),
  subject: text('subject').notNull(),
  issuer: text('issuer').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
  fingerprint: text('fingerprint').notNull(),
  chainValid: boolean('chain_valid').notNull().default(true),
  sanList: jsonb('san_list').notNull().default([]),   // string[]
  keyType: text('key_type'),                          // RSA, ECDSA, etc.
  keySize: integer('key_size'),

  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_certs_host_fingerprint').on(t.hostId, t.fingerprint),
  index('idx_infra_certs_host_expiry').on(t.hostId, t.notAfter),
]);

// ---------------------------------------------------------------------------
// CT log entries — Certificate Transparency log observations
// ---------------------------------------------------------------------------

export const infraCtLogEntries = pgTable('infra_ct_log_entries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  crtShId: bigint('crt_sh_id', { mode: 'bigint' }).notNull(),
  serialNumber: text('serial_number').notNull(),
  issuer: text('issuer').notNull(),
  commonName: text('common_name').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }),
  notAfter: timestamp('not_after', { withTimezone: true }),
  entryTimestamp: timestamp('entry_timestamp', { withTimezone: true }),
  isNew: boolean('is_new').notNull().default(true),

  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_ct_host_crtsh').on(t.hostId, t.crtShId),
  index('idx_infra_ct_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// TLS analyses — cipher suite / protocol version analysis
// ---------------------------------------------------------------------------

export const infraTlsAnalyses = pgTable('infra_tls_analyses', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  tlsVersions: jsonb('tls_versions').notNull().default([]),       // string[]
  cipherSuites: jsonb('cipher_suites').notNull().default([]),     // string[]
  keyExchange: text('key_exchange'),
  certKeyType: text('cert_key_type'),                             // RSA, ECDSA, etc.
  certKeySize: integer('cert_key_size'),
  hasTls13: boolean('has_tls13').notNull().default(false),
  hasTls12: boolean('has_tls12').notNull().default(false),
  hasTls11: boolean('has_tls11').notNull().default(false),
  hasTls10: boolean('has_tls10').notNull().default(false),
  hasWeakCiphers: boolean('has_weak_ciphers').notNull().default(false),
  weakCipherList: jsonb('weak_cipher_list').notNull().default([]),

  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_tls_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// DNS records — current observed DNS records
// ---------------------------------------------------------------------------

export const infraDnsRecords = pgTable('infra_dns_records', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  recordType: text('record_type').notNull(),          // A, AAAA, CNAME, MX, NS, TXT, etc.
  recordValue: text('record_value').notNull(),
  ttl: integer('ttl'),

  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_dns_records_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// DNS changes — detected mutations in DNS records
// ---------------------------------------------------------------------------

export const infraDnsChanges = pgTable('infra_dns_changes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  recordType: text('record_type').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  changeType: text('change_type').notNull(),          // added, modified, removed
  severity: text('severity'),                         // critical, warning, info

  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_dns_changes_host_detected').on(t.hostId, t.detectedAt),
]);

// ---------------------------------------------------------------------------
// DNS health checks — DNSSEC, CAA, DMARC, SPF, dangling CNAMEs
// ---------------------------------------------------------------------------

export const infraDnsHealthChecks = pgTable('infra_dns_health_checks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  dnssecEnabled: boolean('dnssec_enabled').notNull().default(false),
  dnssecDetails: jsonb('dnssec_details').notNull().default({}),
  caaRecords: jsonb('caa_records').notNull().default([]),
  dmarcRecord: text('dmarc_record'),
  dmarcPolicy: text('dmarc_policy'),                  // none, quarantine, reject
  spfRecord: text('spf_record'),
  spfValid: boolean('spf_valid').notNull().default(false),
  danglingCnames: jsonb('dangling_cnames').notNull().default([]),

  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_dns_health_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// WHOIS records — domain registration data
// ---------------------------------------------------------------------------

export const infraWhoisRecords = pgTable('infra_whois_records', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  registrar: text('registrar'),
  registrationDate: timestamp('registration_date', { withTimezone: true }),
  expiryDate: timestamp('expiry_date', { withTimezone: true }),
  updatedDate: timestamp('updated_date', { withTimezone: true }),
  nameServers: jsonb('name_servers').notNull().default([]),       // string[]
  status: jsonb('status').notNull().default([]),                  // EPP status codes
  dnssecSigned: boolean('dnssec_signed').notNull().default(false),
  rawWhois: text('raw_whois'),

  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_whois_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// WHOIS changes — detected mutations in WHOIS data
// ---------------------------------------------------------------------------

export const infraWhoisChanges = pgTable('infra_whois_changes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  fieldName: text('field_name').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),

  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_whois_changes_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// Scan events — record of each scan run against a host
// ---------------------------------------------------------------------------

export const infraScanEvents = pgTable('infra_scan_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  scanRequestId: text('scan_request_id').unique(),    // external correlation ID
  scanType: text('scan_type').notNull(),              // dns, cert, full
  status: text('status').notNull(),                   // running, success, error, partial
  details: jsonb('details').notNull().default({}),

  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_scan_events_host_started').on(t.hostId, t.startedAt),
]);

// ---------------------------------------------------------------------------
// Scan step results — per-step outcome within a scan event
// ---------------------------------------------------------------------------

export const infraScanStepResults = pgTable('infra_scan_step_results', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scanEventId: uuid('scan_event_id').notNull().references(() => infraScanEvents.id, { onDelete: 'cascade' }),

  stepType: text('step_type').notNull(),              // dns_records, dns_health, certificate, tls_analysis, headers, ct_logs, infrastructure, whois
  status: text('status').notNull(),                   // success, error, skipped
  resultData: jsonb('result_data'),
  errorMessage: text('error_message'),

  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_step_per_scan').on(t.scanEventId, t.stepType),
  index('idx_infra_step_results_event').on(t.scanEventId),
]);

// ---------------------------------------------------------------------------
// Score history — historical security scores per host
// ---------------------------------------------------------------------------

export const infraScoreHistory = pgTable('infra_score_history', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  score: integer('score').notNull(),
  grade: text('grade'),                               // A+, A, B, C, D, F
  breakdown: jsonb('breakdown').notNull().default({}), // per-category scores
  deductions: jsonb('deductions').notNull().default([]), // list of deduction reasons

  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_score_host_recorded').on(t.hostId, t.recordedAt),
]);

// ---------------------------------------------------------------------------
// Finding suppressions — tuning: suppress specific findings from score
// ---------------------------------------------------------------------------

export const infraFindingSuppressions = pgTable('infra_finding_suppressions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  category: text('category').notNull(),
  issue: text('issue').notNull(),
  reason: text('reason'),

  suppressedAt: timestamp('suppressed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_suppression').on(t.hostId, t.category, t.issue),
  index('idx_infra_suppressions_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// Scan schedules — periodic scan configuration per host
// ---------------------------------------------------------------------------

export const infraScanSchedules = pgTable('infra_scan_schedules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  enabled: boolean('enabled').notNull().default(true),
  intervalMinutes: integer('interval_minutes').notNull().default(1440),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),

  // Lightweight probe schedule (reachability checks)
  probeEnabled: boolean('probe_enabled').notNull().default(false),
  probeIntervalMinutes: integer('probe_interval_minutes').notNull().default(5),
  probeLastRunAt: timestamp('probe_last_run_at', { withTimezone: true }),
  probeNextRunAt: timestamp('probe_next_run_at', { withTimezone: true }),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_schedule_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// Reachability checks — lightweight probe results
// ---------------------------------------------------------------------------

export const infraReachabilityChecks = pgTable('infra_reachability_checks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  dnsResolved: boolean('dns_resolved').notNull().default(false),
  isReachable: boolean('is_reachable').notNull().default(false),
  httpStatus: integer('http_status'),
  responseTimeMs: integer('response_time_ms'),
  dnsChanged: boolean('dns_changed').notNull().default(false),

  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
}, (t) => [
  index('idx_infra_reachability_host').on(t.hostId),
  index('idx_infra_reachability_checked').on(t.checkedAt),
]);

// ---------------------------------------------------------------------------
// HTTP header checks — security header analysis
// ---------------------------------------------------------------------------

export const infraHttpHeaderChecks = pgTable('infra_http_header_checks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  hstsPresent: boolean('hsts_present').notNull().default(false),
  hstsMaxAge: integer('hsts_max_age'),
  hstsIncludeSubdomains: boolean('hsts_include_subdomains').notNull().default(false),
  hstsPreload: boolean('hsts_preload').notNull().default(false),
  cspPresent: boolean('csp_present').notNull().default(false),
  cspHeader: text('csp_header'),
  xFrameOptions: text('x_frame_options'),
  xContentTypeOptions: boolean('x_content_type_options').notNull().default(false),
  referrerPolicy: text('referrer_policy'),
  permissionsPolicyPresent: boolean('permissions_policy_present').notNull().default(false),
  permissionsPolicyHeader: text('permissions_policy_header'),
  serverHeaderPresent: boolean('server_header_present').notNull().default(false),
  serverHeaderValue: text('server_header_value'),

  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_infra_http_headers_host').on(t.hostId),
]);

// ---------------------------------------------------------------------------
// CDN provider configurations — org's CDN API credentials for origin monitoring
// ---------------------------------------------------------------------------

export const infraCdnProviderConfigs = pgTable('infra_cdn_provider_configs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),              // 'cloudflare' | 'cloudfront'
  displayName: text('display_name').notNull(),
  hostPattern: text('host_pattern'),                 // comma-separated globs, NULL = catch-all
  encryptedCredentials: text('encrypted_credentials').notNull(),  // AES-GCM encrypted JSON
  isValid: boolean('is_valid').notNull().default(false),
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_cdn_provider_pattern').on(t.orgId, t.provider, t.hostPattern),
  index('idx_infra_cdn_provider_org').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// CDN origin records — real origin IPs fetched via CDN provider APIs
// ---------------------------------------------------------------------------

export const infraCdnOriginRecords = pgTable('infra_cdn_origin_records', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  hostId: uuid('host_id').notNull().references(() => infraHosts.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),              // 'cloudflare' | 'cloudfront'
  recordType: text('record_type').notNull(),         // 'ORIGIN_A' | 'ORIGIN_AAAA' | 'ORIGIN_CNAME'
  recordValue: text('record_value').notNull(),

  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_infra_cdn_origin_host_type_value').on(t.hostId, t.recordType, t.recordValue),
  index('idx_infra_cdn_origin_host').on(t.hostId),
]);
