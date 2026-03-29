/**
 * Shared types for the infra scanning module.
 */

export type ScanType = 'full' | 'probe' | 'emergency';

export type StepName =
  | 'dns_records'
  | 'dns_health'
  | 'certificate'
  | 'tls_analysis'
  | 'headers'
  | 'ct_logs'
  | 'infrastructure'
  | 'whois';

export type StepStatus = 'success' | 'error' | 'skipped' | 'running';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface Deduction {
  category: string;
  issue: string;
  points: number;
  severity: Severity;
  evidence: string;
}

export interface ScoreResult {
  hostId: string;
  score: number;
  grade: Grade;
  deductions: Deduction[];
  breakdown: Record<string, number>;
}

export interface StepResult {
  step: StepName;
  status: StepStatus;
  data?: Record<string, unknown>;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface DnsRecord {
  recordType: string;
  recordValue: string;
  ttl?: number;
}

export interface DnsChange {
  recordType: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: 'added' | 'removed' | 'modified';
  severity: Severity;
}

export interface DnsHealthData {
  dnssecEnabled: boolean;
  dnssecDetails: string;
  caaRecords: string;
  dmarcRecord: string | null;
  dmarcPolicy: string | null;
  spfRecord: string | null;
  spfValid: boolean;
  spfTooPermissive?: boolean;
  spfTooManyLookups?: boolean;
  spfLookupCount?: number;
  spfMissingTerminator?: boolean;
  danglingCnames: string;
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  chainValid: boolean;
  sanList: string[];
  keyType?: string;
  keySize?: number;
  signatureAlgorithm?: string;
  selfSigned?: boolean;
  weakKey?: boolean;
  sha1Signature?: boolean;
}

export interface TlsInfo {
  hasTls10: boolean;
  hasTls11: boolean;
  hasTls12: boolean;
  hasTls13: boolean;
  hasWeakCiphers: boolean;
  weakCipherList: string[];
  supportedVersions: string[];
}

export interface HeaderInfo {
  hstsPresent: boolean;
  hstsValue: string | null;
  cspPresent: boolean;
  cspValue: string | null;
  xFrameOptions: string | null;
  xContentTypeOptions: boolean;
  referrerPolicy: string | null;
  permissionsPolicy: string | null;
  serverHeaderPresent: boolean;
  serverHeaderValue: string | null;
}

export interface InfraResult {
  ip: string;
  version: 4 | 6;
  reverseDns: string | null;
  cloudProvider: string | null;
  ports: PortResult[];
  geoCountry?: string | null;
  geoCity?: string | null;
  geoLat?: number | null;
  geoLon?: number | null;
  asn?: string | null;
  asnOrg?: string | null;
}

export interface PortResult {
  port: number;
  open: boolean;
  service?: string;
}

export interface WhoisData {
  registrar: string | null;
  registrationDate: string | null;
  expiryDate: string | null;
  updatedDate: string | null;
  nameServers: string;
  status: string;
  dnssecSigned: boolean;
  rawWhois: string | null;
}

export interface WhoisChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface CtLogEntry {
  crtShId: number;
  issuerName: string;
  commonName: string;
  nameValue: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  entryTimestamp: string;
}

export interface ScanJobData {
  hostId: string;
  targetName: string;
  scanType: ScanType;
  isRoot: boolean;
  orgId?: string;
  scanRequestId?: string;
}

/** BullMQ priority values: lower number = higher priority. */
export const SCAN_PRIORITIES = {
  emergency: 1,
  interactive: 5,
  scheduled: 10,
} as const;

export interface ProbeResult {
  hostId: string;
  hostName: string;
  dnsResolved: boolean;
  isReachable: boolean;
  httpStatus: number | null;
  responseTimeMs: number | null;
  dnsChanged: boolean;
  dnsChangesCount: number;
  dnsChanges: DnsChange[];
  alerted: boolean;
}
