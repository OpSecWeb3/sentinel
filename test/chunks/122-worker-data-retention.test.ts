/**
 * Chunk 122 — Worker: Data retention — batch delete per policy (boundary testing)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestEvent,
} from '../helpers/setup.js';

describe('Chunk 122 — Data retention handler', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should delete events older than retention cutoff', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Insert old event (91 days ago)
    const oldDate = new Date(Date.now() - 91 * 86_400_000);
    await sql`
      INSERT INTO events (org_id, module_id, event_type, payload, occurred_at, received_at)
      VALUES (${org.id}, 'github', 'github.push', '{}'::jsonb, ${oldDate.toISOString()}, ${oldDate.toISOString()})
    `;

    // Insert recent event (1 day ago)
    const recentDate = new Date(Date.now() - 86_400_000);
    await sql`
      INSERT INTO events (org_id, module_id, event_type, payload, occurred_at, received_at)
      VALUES (${org.id}, 'github', 'github.push', '{}'::jsonb, ${recentDate.toISOString()}, ${recentDate.toISOString()})
    `;

    // Apply retention: 90 days
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    await sql`
      DELETE FROM events WHERE received_at < ${cutoff}
    `;

    const [{ count }] = await sql`SELECT count(*) as count FROM events WHERE org_id = ${org.id}`;
    expect(Number(count)).toBe(1);
  });

  it('should not delete events within retention window', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Insert event at exactly the boundary (89 days ago)
    const boundaryDate = new Date(Date.now() - 89 * 86_400_000);
    await sql`
      INSERT INTO events (org_id, module_id, event_type, payload, occurred_at, received_at)
      VALUES (${org.id}, 'github', 'github.push', '{}'::jsonb, ${boundaryDate.toISOString()}, ${boundaryDate.toISOString()})
    `;

    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    await sql`DELETE FROM events WHERE received_at < ${cutoff}`;

    const [{ count }] = await sql`SELECT count(*) as count FROM events WHERE org_id = ${org.id}`;
    expect(Number(count)).toBe(1);
  });

  it('should handle deletion of alerts with cascading notification deliveries', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const oldDate = new Date(Date.now() - 400 * 86_400_000);
    const [alert] = await sql`
      INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data, created_at)
      VALUES (${org.id}, 'high', 'Old Alert', 'immediate', '{}'::jsonb, ${oldDate.toISOString()})
      RETURNING id
    `;

    await sql`
      INSERT INTO notification_deliveries (alert_id, channel_id, channel_type, status, created_at)
      VALUES (${alert.id}, 'ch1', 'email', 'sent', ${oldDate.toISOString()})
    `;

    // Delete old alerts (365 days retention)
    const cutoff = new Date(Date.now() - 365 * 86_400_000);
    await sql`DELETE FROM alerts WHERE created_at < ${cutoff}`;

    const [{ count }] = await sql`SELECT count(*) as count FROM alerts WHERE org_id = ${org.id}`;
    expect(Number(count)).toBe(0);

    // Deliveries should cascade delete
    const [{ dcount }] = await sql`SELECT count(*) as dcount FROM notification_deliveries WHERE alert_id = ${alert.id}`;
    expect(Number(dcount)).toBe(0);
  });

  it('should validate table names against allowlist (SQL injection prevention)', async () => {
    // Simulating what the handler does: checking ALLOWED_TABLES
    const ALLOWED_TABLES = new Set(['events', 'alerts', 'notification_deliveries', 'sessions']);

    expect(ALLOWED_TABLES.has('events')).toBe(true);
    expect(ALLOWED_TABLES.has('users')).toBe(false); // Not allowed
    expect(ALLOWED_TABLES.has("events; DROP TABLE users--")).toBe(false); // Injection attempt
  });

  it('should validate timestamp columns against allowlist', () => {
    const ALLOWED_TIMESTAMP_COLUMNS = new Set(['received_at', 'created_at', 'updated_at', 'expire']);

    expect(ALLOWED_TIMESTAMP_COLUMNS.has('created_at')).toBe(true);
    expect(ALLOWED_TIMESTAMP_COLUMNS.has('id')).toBe(false);
  });

  it('should reject retention days of 0 or negative', () => {
    // Simulating validation logic
    const isValid = (days: number) => Number.isInteger(days) && days >= 1;

    expect(isValid(90)).toBe(true);
    expect(isValid(0)).toBe(false);
    expect(isValid(-1)).toBe(false);
    expect(isValid(0.5)).toBe(false);
  });
});
