/**
 * Step 8: WHOIS lookup via raw socket to port 43.
 *
 * Connects to the appropriate WHOIS server, parses registrar, creation date,
 * expiry date, name servers, and status codes. Supports change detection.
 */
import net from 'node:net';

import type { StepResult, WhoisChange, WhoisData } from '../types.js';

const WHOIS_PORT = 43;
const SOCKET_TIMEOUT_MS = 15_000;

/** TLD to WHOIS server mapping for common TLDs. */
const WHOIS_SERVERS: Record<string, string> = {
  com: 'whois.verisign-grs.com',
  net: 'whois.verisign-grs.com',
  org: 'whois.pir.org',
  io: 'whois.nic.io',
  co: 'whois.nic.co',
  dev: 'whois.nic.google',
  app: 'whois.nic.google',
  ai: 'whois.nic.ai',
  me: 'whois.nic.me',
  info: 'whois.afilias.net',
  xyz: 'whois.nic.xyz',
  uk: 'whois.nic.uk',
  de: 'whois.denic.de',
  fr: 'whois.nic.fr',
  nl: 'whois.sidn.nl',
  eu: 'whois.eu',
  ca: 'whois.cira.ca',
  au: 'whois.auda.org.au',
};

const DEFAULT_WHOIS_SERVER = 'whois.iana.org';

// -------------------------------------------------------------------------
// Raw WHOIS query
// -------------------------------------------------------------------------

function getWhoisServer(domain: string): string {
  const parts = domain.split('.');
  const tld = parts[parts.length - 1].toLowerCase();
  return WHOIS_SERVERS[tld] ?? DEFAULT_WHOIS_SERVER;
}

/**
 * Sanitize domain for WHOIS query: strip \r, \n, and non-printable characters
 * to prevent injection of extra WHOIS commands.
 */
function sanitizeDomainForWhois(domain: string): string {
  // eslint-disable-next-line no-control-regex
  return domain.replace(/[\r\n\x00-\x1f\x7f-\x9f]/g, '').trim();
}

function queryWhois(domain: string, server: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sanitized = sanitizeDomainForWhois(domain);
    const socket = new net.Socket();
    let data = '';

    socket.setTimeout(SOCKET_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(`${sanitized}\r\n`);
    });

    socket.on('data', (chunk) => {
      data += chunk.toString();
    });

    socket.on('end', () => {
      socket.destroy();
      resolve(data);
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`WHOIS query to ${server} timed out`));
    });

    socket.connect(WHOIS_PORT, server);
  });
}

// -------------------------------------------------------------------------
// WHOIS parsing
// -------------------------------------------------------------------------

/**
 * Parse a date string from WHOIS output. Handles various formats.
 */
function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try direct ISO parse
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) return date.toISOString();

  return null;
}

/**
 * Parse raw WHOIS text into structured data.
 */
function parseWhoisData(rawWhois: string): Omit<WhoisData, 'rawWhois'> {
  let registrar: string | null = null;
  let registrationDate: string | null = null;
  let expiryDate: string | null = null;
  let updatedDate: string | null = null;
  const nameServers: string[] = [];
  const statusCodes: string[] = [];
  let dnssecSigned = false;

  const lines = rawWhois.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%') || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (!value) continue;

    switch (key) {
      case 'registrar':
      case 'sponsoring registrar':
      case 'registrar name':
        if (!registrar) registrar = value;
        break;

      case 'creation date':
      case 'created':
      case 'registered':
      case 'registration date':
      case 'domain name commencement date':
        if (!registrationDate) registrationDate = parseDate(value);
        break;

      case 'registry expiry date':
      case 'expiry date':
      case 'expires':
      case 'expiration date':
      case 'paid-till':
        if (!expiryDate) expiryDate = parseDate(value);
        break;

      case 'updated date':
      case 'last updated':
      case 'last modified':
      case 'changed':
        if (!updatedDate) updatedDate = parseDate(value);
        break;

      case 'name server':
      case 'nserver':
        nameServers.push(value.toLowerCase());
        break;

      case 'domain status':
      case 'status': {
        // Status often includes a URL, strip it
        const status = value.split(/\s+/)[0];
        if (status && !statusCodes.includes(status)) {
          statusCodes.push(status);
        }
        break;
      }

      case 'dnssec':
        dnssecSigned = value.toLowerCase() === 'signeddelegation' || value.toLowerCase() === 'yes';
        break;
    }
  }

  return {
    registrar,
    registrationDate,
    expiryDate,
    updatedDate,
    nameServers: JSON.stringify(nameServers),
    status: JSON.stringify(statusCodes),
    dnssecSigned,
  };
}

// -------------------------------------------------------------------------
// Change detection
// -------------------------------------------------------------------------

/**
 * Compare current WHOIS data against previously stored data.
 * Returns a list of field-level changes.
 */
export function detectWhoisChanges(
  current: WhoisData,
  stored: WhoisData | null,
): WhoisChange[] {
  if (!stored) return [];

  const changes: WhoisChange[] = [];
  const fields: Array<{ name: string; currentVal: string | null; storedVal: string | null }> = [
    { name: 'registrar', currentVal: current.registrar, storedVal: stored.registrar },
    { name: 'expiryDate', currentVal: current.expiryDate, storedVal: stored.expiryDate },
    { name: 'nameServers', currentVal: current.nameServers, storedVal: stored.nameServers },
    { name: 'dnssecSigned', currentVal: String(current.dnssecSigned), storedVal: String(stored.dnssecSigned) },
  ];

  for (const { name, currentVal, storedVal } of fields) {
    if (currentVal !== storedVal) {
      changes.push({ fieldName: name, oldValue: storedVal, newValue: currentVal });
    }
  }

  return changes;
}

// -------------------------------------------------------------------------
// Full WHOIS lookup
// -------------------------------------------------------------------------

export async function getWhoisData(domain: string): Promise<WhoisData> {
  const server = getWhoisServer(domain);
  let rawWhois = await queryWhois(domain, server);

  // For Verisign, we get a referral to the registrar's WHOIS server
  const referralMatch = rawWhois.match(/Registrar WHOIS Server:\s*(.+)/i);
  if (referralMatch) {
    const referralServer = referralMatch[1].trim();
    try {
      const detailedWhois = await queryWhois(domain, referralServer);
      if (detailedWhois.length > rawWhois.length) {
        rawWhois = detailedWhois;
      }
    } catch {
      // Fall back to the initial WHOIS data
    }
  }

  const parsed = parseWhoisData(rawWhois);

  return {
    ...parsed,
    rawWhois,
  };
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runWhoisStep(
  domain: string,
  options: { isRoot: boolean; storedWhois?: WhoisData | null },
): Promise<StepResult> {
  const startedAt = new Date();

  if (!options.isRoot) {
    return { step: 'whois', status: 'skipped', startedAt, completedAt: new Date() };
  }

  try {
    const whoisData = await getWhoisData(domain);
    const whoisChanges = detectWhoisChanges(whoisData, options.storedWhois ?? null);

    return {
      step: 'whois',
      status: 'success',
      data: {
        ...whoisData,
        whoisChanges,
        whoisChangesCount: whoisChanges.length,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'whois',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
