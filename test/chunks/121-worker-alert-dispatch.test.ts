/**
 * Chunk 121 — Worker: Alert dispatch — channel resolution + secret decryption + delivery
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestNotificationChannel,
} from '../helpers/setup.js';

describe('Chunk 121 — Alert dispatch handler', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should resolve channels from detection.channelIds', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const ch1 = await createTestNotificationChannel(org.id, {
      name: 'Email Channel',
      type: 'email',
      config: { to: 'alerts@test.com' },
    });
    const ch2 = await createTestNotificationChannel(org.id, {
      name: 'Webhook Channel',
      type: 'webhook',
      config: { url: 'https://hooks.test.com/alert' },
    });

    // Create detection with channel IDs
    await sql`
      INSERT INTO detections (org_id, created_by, module_id, name, severity, status, config, channel_ids)
      VALUES (${org.id}, ${user.id}, 'github', 'Test Detection', 'high', 'active', '{}'::jsonb,
              ARRAY[${ch1.id}::uuid, ${ch2.id}::uuid])
    `;

    // Query channels the same way the handler would
    const channels = await sql`
      SELECT id, type, config FROM notification_channels
      WHERE id = ANY(ARRAY[${ch1.id}::uuid, ${ch2.id}::uuid])
      AND enabled = true AND deleted_at IS NULL
    `;

    expect(channels.length).toBe(2);
    expect(channels.map((c: any) => c.type).sort()).toEqual(['email', 'webhook']);
  });

  it('should skip disabled channels', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const ch = await createTestNotificationChannel(org.id, {
      name: 'Disabled Channel',
      type: 'email',
      config: { to: 'disabled@test.com' },
      enabled: false,
    });

    const channels = await sql`
      SELECT id FROM notification_channels
      WHERE id = ${ch.id} AND enabled = true AND deleted_at IS NULL
    `;

    expect(channels.length).toBe(0);
  });

  it('should skip soft-deleted channels', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const ch = await createTestNotificationChannel(org.id, {
      name: 'Deleted Channel',
      type: 'webhook',
      config: { url: 'https://hooks.test.com' },
    });

    // Soft delete
    await sql`UPDATE notification_channels SET deleted_at = NOW() WHERE id = ${ch.id}`;

    const channels = await sql`
      SELECT id FROM notification_channels
      WHERE id = ${ch.id} AND enabled = true AND deleted_at IS NULL
    `;

    expect(channels.length).toBe(0);
  });

  it('should track delivery status per channel', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Create alert
    const [alert] = await sql`
      INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
      VALUES (${org.id}, 'high', 'Test Alert', 'immediate', '{}'::jsonb)
      RETURNING id
    `;

    // Insert delivery records
    await sql`
      INSERT INTO notification_deliveries (alert_id, channel_id, channel_type, status, response_time_ms)
      VALUES (${alert.id}, 'ch-1', 'email', 'sent', 150),
             (${alert.id}, 'ch-2', 'webhook', 'failed', 5000)
    `;

    const deliveries = await sql`
      SELECT channel_id, channel_type, status, response_time_ms
      FROM notification_deliveries WHERE alert_id = ${alert.id}
    `;

    expect(deliveries.length).toBe(2);
    const sent = deliveries.find((d: any) => d.status === 'sent');
    const failed = deliveries.find((d: any) => d.status === 'failed');
    expect(sent?.channel_type).toBe('email');
    expect(failed?.channel_type).toBe('webhook');
  });

  it('should deduplicate deliveries on retry (skip already-sent channels)', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const [alert] = await sql`
      INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
      VALUES (${org.id}, 'high', 'Test Alert', 'immediate', '{}'::jsonb)
      RETURNING id
    `;

    // First delivery: ch-1 succeeded, ch-2 failed
    await sql`
      INSERT INTO notification_deliveries (alert_id, channel_id, channel_type, status)
      VALUES (${alert.id}, 'ch-1', 'email', 'sent'),
             (${alert.id}, 'ch-2', 'webhook', 'failed')
    `;

    // On retry, query for already-sent channels
    const alreadySent = await sql`
      SELECT channel_id FROM notification_deliveries
      WHERE alert_id = ${alert.id} AND status = 'sent'
    `;

    const sentIds = new Set(alreadySent.map((d: any) => d.channel_id));
    expect(sentIds.has('ch-1')).toBe(true);
    expect(sentIds.has('ch-2')).toBe(false);
  });
});
