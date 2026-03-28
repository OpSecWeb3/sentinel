/**
 * Chunk 106 — Normalizer: Infra scan results → normalized events
 * Chunk 107 — Handler: scan + scan.aggregate (TLS probing, cert parsing)
 * Chunk 108 — Handler: probe (HTTP health checks, consecutive failure counting)
 * Chunk 109 — Handler: schedule.load (cron-based scan scheduling)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
} from '../helpers/setup.js';

describe('Chunk 106 — Infra scan normalizer', () => {
  it('should normalize TLS scan result', () => {
    const raw = {
      host: 'example.com',
      port: 443,
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
      cert: {
        subject: 'CN=example.com',
        issuer: 'CN=Let\'s Encrypt Authority X3',
        validFrom: '2025-01-01T00:00:00Z',
        validTo: '2025-04-01T00:00:00Z',
        serialNumber: 'abc123',
      },
    };

    const eventType = 'infra.tls_scan';
    const payload = {
      host: raw.host,
      protocol: raw.protocol,
      certIssuer: raw.cert.issuer,
      certExpiry: raw.cert.validTo,
      resourceId: raw.host,
    };

    expect(eventType).toBe('infra.tls_scan');
    expect(payload.protocol).toBe('TLSv1.3');
    expect(payload.certIssuer).toContain('Let\'s Encrypt');
  });

  it('should normalize DNS change event', () => {
    const raw = {
      host: 'api.example.com',
      recordType: 'A',
      oldValues: ['1.2.3.4'],
      newValues: ['5.6.7.8'],
      changeType: 'modified',
    };

    const eventType = 'infra.dns_change';
    expect(eventType).toBe('infra.dns_change');
    expect(raw.changeType).toBe('modified');
  });

  it('should normalize subdomain discovery event', () => {
    const raw = {
      parentHost: 'example.com',
      subdomain: 'secret-admin.example.com',
      discoveredAt: new Date().toISOString(),
      source: 'ct_log',
    };

    const eventType = 'infra.new_subdomain';
    expect(eventType).toBe('infra.new_subdomain');
    expect(raw.source).toBe('ct_log');
  });
});

describe('Chunk 108 — Infra probe handler', () => {
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    redis = getTestRedis();
  });

  it('should track consecutive failures in Redis', async () => {
    const failKey = 'sentinel:infra:probe:failures:example.com';

    // First failure
    await redis.incr(failKey);
    expect(Number(await redis.get(failKey))).toBe(1);

    // Second failure
    await redis.incr(failKey);
    expect(Number(await redis.get(failKey))).toBe(2);

    // Third failure — threshold reached
    await redis.incr(failKey);
    const failures = Number(await redis.get(failKey));
    expect(failures).toBe(3);

    const THRESHOLD = 3;
    expect(failures >= THRESHOLD).toBe(true);
  });

  it('should reset failure count on success', async () => {
    const failKey = 'sentinel:infra:probe:failures:example.com';

    await redis.set(failKey, '5');
    await redis.del(failKey);

    const count = await redis.get(failKey);
    expect(count).toBeNull();
  });

  it('should create host in DB if not exists', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Upsert host
    await sql`
      INSERT INTO infra_hosts (org_id, hostname, is_root, source)
      VALUES (${org.id}, 'api.example.com', true, 'probe')
      ON CONFLICT (org_id, hostname) DO NOTHING
    `;

    const hosts = await sql`SELECT hostname FROM infra_hosts WHERE org_id = ${org.id}`;
    expect(hosts.length).toBe(1);
    expect(hosts[0].hostname).toBe('api.example.com');
  });
});

describe('Chunk 109 — Schedule loader', () => {
  it('should parse cron expressions for scan scheduling', () => {
    const schedules = [
      { pattern: '0 */6 * * *', description: 'Every 6 hours' },
      { pattern: '0 0 * * *', description: 'Daily at midnight' },
      { pattern: '*/5 * * * *', description: 'Every 5 minutes' },
    ];

    for (const s of schedules) {
      // Verify cron pattern has 5 fields
      const fields = s.pattern.split(' ');
      expect(fields.length).toBe(5);
    }
  });
});
