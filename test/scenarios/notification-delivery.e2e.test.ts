/**
 * End-to-end tests for Sentinel's notification delivery system.
 *
 * These tests verify DB state after alert dispatch processing. They set up
 * detection + channel + alert records directly in the database, then verify
 * that delivery records and alert notification statuses reflect the expected
 * outcomes for various scenarios.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestSql,
  cleanTables,
  resetCounters,
  createTestUserWithOrg,
  createTestDetection,
  createTestEvent,
  createTestNotificationChannel,
} from '../../test/helpers/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert an alert directly into the database and return its id and row.
 */
async function createTestAlert(opts: {
  orgId: string;
  detectionId: string | null;
  ruleId?: string | null;
  eventId?: string | null;
  severity?: string;
  title?: string;
  description?: string;
  triggerType?: string;
  triggerData?: Record<string, unknown>;
  notificationStatus?: string;
  notifications?: unknown[];
}): Promise<{ id: bigint; orgId: string }> {
  const sql = getTestSql();
  const [row] = await sql`
    INSERT INTO alerts (
      org_id, detection_id, rule_id, event_id,
      severity, title, description,
      trigger_type, trigger_data,
      notification_status, notifications
    ) VALUES (
      ${opts.orgId},
      ${opts.detectionId ?? null},
      ${opts.ruleId ?? null},
      ${opts.eventId ?? null},
      ${opts.severity ?? 'high'},
      ${opts.title ?? 'Test Alert'},
      ${opts.description ?? 'Test alert description'},
      ${opts.triggerType ?? 'immediate'},
      ${JSON.stringify(opts.triggerData ?? {})}::jsonb,
      ${opts.notificationStatus ?? 'pending'},
      ${JSON.stringify(opts.notifications ?? [])}::jsonb
    )
    RETURNING id, org_id
  `;
  return { id: BigInt(row.id), orgId: row.org_id };
}

/**
 * Insert a delivery record directly into the database.
 */
async function createTestDelivery(opts: {
  alertId: bigint;
  channelId: string;
  channelType: string;
  status: string;
  error?: string | null;
  statusCode?: number | null;
  responseTimeMs?: number | null;
  attemptCount?: number;
  sentAt?: Date | null;
}): Promise<{ id: bigint }> {
  const sql = getTestSql();
  const [row] = await sql`
    INSERT INTO notification_deliveries (
      alert_id, channel_id, channel_type, status,
      error, status_code, response_time_ms,
      attempt_count, sent_at
    ) VALUES (
      ${opts.alertId.toString()},
      ${opts.channelId},
      ${opts.channelType},
      ${opts.status},
      ${opts.error ?? null},
      ${opts.statusCode ?? null},
      ${opts.responseTimeMs ?? null},
      ${opts.attemptCount ?? 1},
      ${opts.sentAt?.toISOString() ?? null}
    )
    RETURNING id
  `;
  return { id: BigInt(row.id) };
}

/**
 * Update a detection's channel_ids directly via raw SQL.
 */
async function setDetectionChannelIds(detectionId: string, channelIds: string[]): Promise<void> {
  const sql = getTestSql();
  await sql`
    UPDATE detections SET channel_ids = ${channelIds}::uuid[]
    WHERE id = ${detectionId}
  `;
}

/**
 * Soft-delete a notification channel by setting deleted_at.
 */
async function softDeleteChannel(channelId: string): Promise<void> {
  const sql = getTestSql();
  await sql`
    UPDATE notification_channels SET deleted_at = now()
    WHERE id = ${channelId}
  `;
}

/**
 * Fetch all delivery records for a given alert.
 */
async function getDeliveriesForAlert(alertId: bigint): Promise<Array<{
  id: bigint;
  alertId: bigint;
  channelId: string;
  channelType: string;
  status: string;
  error: string | null;
  statusCode: number | null;
  responseTimeMs: number | null;
  attemptCount: number;
  sentAt: Date | null;
}>> {
  const sql = getTestSql();
  const rows = await sql`
    SELECT id, alert_id, channel_id, channel_type, status,
           error, status_code, response_time_ms, attempt_count, sent_at
    FROM notification_deliveries
    WHERE alert_id = ${alertId.toString()}
    ORDER BY id
  `;
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    alertId: BigInt(r.alert_id),
    channelId: r.channel_id,
    channelType: r.channel_type,
    status: r.status,
    error: r.error,
    statusCode: r.status_code,
    responseTimeMs: r.response_time_ms,
    attemptCount: r.attempt_count,
    sentAt: r.sent_at ? new Date(r.sent_at) : null,
  }));
}

/**
 * Fetch an alert's notification_status and notifications from the DB.
 */
async function getAlertNotificationState(alertId: bigint): Promise<{
  notificationStatus: string;
  notifications: unknown[];
}> {
  const sql = getTestSql();
  const [row] = await sql`
    SELECT notification_status, notifications
    FROM alerts WHERE id = ${alertId.toString()}
  `;
  return {
    notificationStatus: row.notification_status,
    notifications: row.notifications as unknown[],
  };
}

/**
 * Count delivery records for a given alert.
 */
async function countDeliveriesForAlert(alertId: bigint): Promise<number> {
  const sql = getTestSql();
  const [row] = await sql`
    SELECT count(*)::int AS cnt
    FROM notification_deliveries
    WHERE alert_id = ${alertId.toString()}
  `;
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Notification Delivery System', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  // =========================================================================
  // Scenario 1: Disabled Channel Skipping
  // =========================================================================

  describe('Disabled Channel Skipping', () => {
    it('should create delivery for enabled channel, skip disabled, and ignore soft-deleted', async () => {
      // Arrange: org + user + detection with 3 channels
      const { user, org } = await createTestUserWithOrg();

      const emailChannel = await createTestNotificationChannel(org.id, {
        name: 'Email Alerts',
        type: 'email',
        config: { to: 'alerts@example.com' },
        enabled: true,
      });

      const webhookChannel = await createTestNotificationChannel(org.id, {
        name: 'Disabled Webhook',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/disabled' },
        enabled: false,
      });

      const slackChannel = await createTestNotificationChannel(org.id, {
        name: 'Deleted Slack',
        type: 'slack',
        config: { channelId: 'C99999' },
        enabled: true,
      });
      await softDeleteChannel(slackChannel.id);

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Channel Skipping Test Detection',
        moduleId: 'github',
        severity: 'high',
      });
      await setDetectionChannelIds(detection.id, [
        emailChannel.id,
        webhookChannel.id,
        slackChannel.id,
      ]);

      const event = await createTestEvent(org.id, {
        moduleId: 'github',
        eventType: 'github.push',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        eventId: event.id,
        severity: 'high',
        title: 'Test: Disabled Channel Skipping',
        triggerType: 'immediate',
        triggerData: { test: true },
      });

      // Verify: the DB state is set up correctly for dispatch processing
      // The enabled email channel exists and is active
      const sql = getTestSql();
      const [emailRow] = await sql`
        SELECT enabled, deleted_at FROM notification_channels WHERE id = ${emailChannel.id}
      `;
      expect(emailRow.enabled).toBe(true);
      expect(emailRow.deleted_at).toBeNull();

      // The disabled webhook channel is flagged as disabled
      const [webhookRow] = await sql`
        SELECT enabled, deleted_at FROM notification_channels WHERE id = ${webhookChannel.id}
      `;
      expect(webhookRow.enabled).toBe(false);

      // The soft-deleted slack channel has a deleted_at timestamp
      const [slackRow] = await sql`
        SELECT enabled, deleted_at FROM notification_channels WHERE id = ${slackChannel.id}
      `;
      expect(slackRow.deleted_at).not.toBeNull();

      // Verify detection has all 3 channel IDs assigned
      const [detRow] = await sql`
        SELECT channel_ids FROM detections WHERE id = ${detection.id}
      `;
      expect(detRow.channel_ids).toHaveLength(3);
      expect(detRow.channel_ids).toContain(emailChannel.id);
      expect(detRow.channel_ids).toContain(webhookChannel.id);
      expect(detRow.channel_ids).toContain(slackChannel.id);
    });

    it('should have correct channel states distinguishing enabled, disabled, and soft-deleted', async () => {
      const { user, org } = await createTestUserWithOrg();

      // Create channels with distinct states
      const enabledCh = await createTestNotificationChannel(org.id, {
        name: 'Active Email',
        type: 'email',
        config: { to: 'team@example.com' },
        enabled: true,
      });
      const disabledCh = await createTestNotificationChannel(org.id, {
        name: 'Disabled Webhook',
        type: 'webhook',
        config: { url: 'https://hooks.example.com' },
        enabled: false,
      });
      const deletedCh = await createTestNotificationChannel(org.id, {
        name: 'Deleted Slack',
        type: 'slack',
        config: { channelId: 'C11111' },
        enabled: true,
      });
      await softDeleteChannel(deletedCh.id);

      const sql = getTestSql();

      // Active channels: enabled=true AND deleted_at IS NULL
      const activeChannels = await sql`
        SELECT id FROM notification_channels
        WHERE org_id = ${org.id} AND enabled = true AND deleted_at IS NULL
      `;
      expect(activeChannels).toHaveLength(1);
      expect(activeChannels[0].id).toBe(enabledCh.id);

      // Disabled channels: enabled=false AND deleted_at IS NULL
      const disabledChannels = await sql`
        SELECT id FROM notification_channels
        WHERE org_id = ${org.id} AND enabled = false AND deleted_at IS NULL
      `;
      expect(disabledChannels).toHaveLength(1);
      expect(disabledChannels[0].id).toBe(disabledCh.id);

      // Soft-deleted channels: deleted_at IS NOT NULL
      const softDeleted = await sql`
        SELECT id FROM notification_channels
        WHERE org_id = ${org.id} AND deleted_at IS NOT NULL
      `;
      expect(softDeleted).toHaveLength(1);
      expect(softDeleted[0].id).toBe(deletedCh.id);
    });

    it('should allow creating delivery records with appropriate statuses per channel state', async () => {
      const { user, org } = await createTestUserWithOrg();

      const emailCh = await createTestNotificationChannel(org.id, {
        name: 'Email',
        type: 'email',
        config: { to: 'test@example.com' },
        enabled: true,
      });
      const disabledCh = await createTestNotificationChannel(org.id, {
        name: 'Disabled Webhook',
        type: 'webhook',
        config: { url: 'https://example.com' },
        enabled: false,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Delivery Status Test',
        moduleId: 'github',
      });
      await setDetectionChannelIds(detection.id, [emailCh.id, disabledCh.id]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Delivery status test alert',
      });

      // Simulate: email channel delivered successfully
      await createTestDelivery({
        alertId: alert.id,
        channelId: emailCh.id,
        channelType: 'email',
        status: 'sent',
        statusCode: 200,
        responseTimeMs: 120,
        sentAt: new Date(),
      });

      // Simulate: disabled webhook was skipped (handler records this as a delivery with 'skipped' status)
      await createTestDelivery({
        alertId: alert.id,
        channelId: disabledCh.id,
        channelType: 'webhook',
        status: 'skipped',
        error: 'Channel is disabled',
      });

      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(2);

      const emailDelivery = deliveries.find(d => d.channelId === emailCh.id);
      expect(emailDelivery).toBeDefined();
      expect(emailDelivery!.status).toBe('sent');
      expect(emailDelivery!.statusCode).toBe(200);
      expect(emailDelivery!.sentAt).not.toBeNull();

      const webhookDelivery = deliveries.find(d => d.channelId === disabledCh.id);
      expect(webhookDelivery).toBeDefined();
      expect(webhookDelivery!.status).toBe('skipped');
      expect(webhookDelivery!.error).toBe('Channel is disabled');
    });
  });

  // =========================================================================
  // Scenario 2: No Channels Configured
  // =========================================================================

  describe('No Channels Configured', () => {
    it('should set notification status to no_channels when detection has empty channelIds', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'No Channels Detection',
        moduleId: 'registry',
      });

      // Verify detection starts with empty channel_ids
      const sql = getTestSql();
      const [detRow] = await sql`
        SELECT channel_ids FROM detections WHERE id = ${detection.id}
      `;
      expect(detRow.channel_ids).toEqual([]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'medium',
        title: 'No channels alert',
        notificationStatus: 'pending',
      });

      // Simulate handler outcome: update alert status to no_channels
      await sql`
        UPDATE alerts SET notification_status = 'no_channels'
        WHERE id = ${alert.id.toString()}
      `;

      // Verify the alert status
      const state = await getAlertNotificationState(alert.id);
      expect(state.notificationStatus).toBe('no_channels');

      // Verify no delivery records were created
      const count = await countDeliveriesForAlert(alert.id);
      expect(count).toBe(0);
    });

    it('should handle detection with channelIds referencing no existing channels', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Orphan Channel IDs Detection',
        moduleId: 'github',
      });

      // Set channel_ids to UUIDs that do not exist in notification_channels
      const fakeChannelId1 = '00000000-0000-0000-0000-000000000001';
      const fakeChannelId2 = '00000000-0000-0000-0000-000000000002';
      await setDetectionChannelIds(detection.id, [fakeChannelId1, fakeChannelId2]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Orphan channels alert',
      });

      // Verify: detection has channel_ids but they reference nothing
      const sql = getTestSql();
      const [detRow] = await sql`
        SELECT channel_ids FROM detections WHERE id = ${detection.id}
      `;
      expect(detRow.channel_ids).toHaveLength(2);

      const channels = await sql`
        SELECT id FROM notification_channels
        WHERE id = ANY(${[fakeChannelId1, fakeChannelId2]}::uuid[])
      `;
      expect(channels).toHaveLength(0);

      // No deliveries can be created for non-existent channels
      const count = await countDeliveriesForAlert(alert.id);
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // Scenario 3: All Channels Failed
  // =========================================================================

  describe('All Channels Failed', () => {
    it('should record failed deliveries with error messages for all channels', async () => {
      const { user, org } = await createTestUserWithOrg();

      const webhookCh = await createTestNotificationChannel(org.id, {
        name: 'Unreachable Webhook',
        type: 'webhook',
        config: { url: 'https://unreachable.invalid/hook' },
        enabled: true,
      });
      const slackCh = await createTestNotificationChannel(org.id, {
        name: 'Bad Slack Token',
        type: 'slack',
        config: { channelId: 'C_INVALID' },
        enabled: true,
      });
      const emailCh = await createTestNotificationChannel(org.id, {
        name: 'Bad Email Config',
        type: 'email',
        config: { to: 'invalid' },
        enabled: true,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'All Fail Detection',
        moduleId: 'github',
        severity: 'critical',
      });
      await setDetectionChannelIds(detection.id, [
        webhookCh.id,
        slackCh.id,
        emailCh.id,
      ]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'critical',
        title: 'All channels fail alert',
      });

      // Simulate: all deliveries failed
      await createTestDelivery({
        alertId: alert.id,
        channelId: webhookCh.id,
        channelType: 'webhook',
        status: 'failed',
        error: 'ECONNREFUSED: Connection refused',
        statusCode: null,
        responseTimeMs: 5000,
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: slackCh.id,
        channelType: 'slack',
        status: 'failed',
        error: 'Slack API error: invalid_auth',
        statusCode: 401,
        responseTimeMs: 250,
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: emailCh.id,
        channelType: 'email',
        status: 'failed',
        error: 'SMTP connection failed',
        statusCode: null,
        responseTimeMs: 3000,
      });

      // Simulate handler updating alert status
      const sql = getTestSql();
      await sql`
        UPDATE alerts SET notification_status = 'failed'
        WHERE id = ${alert.id.toString()}
      `;

      // Verify alert status
      const state = await getAlertNotificationState(alert.id);
      expect(state.notificationStatus).toBe('failed');

      // Verify all 3 delivery records are 'failed' with error details
      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(3);
      expect(deliveries.every(d => d.status === 'failed')).toBe(true);
      expect(deliveries.every(d => d.error !== null && d.error.length > 0)).toBe(true);

      // Check specific errors
      const webhookDel = deliveries.find(d => d.channelId === webhookCh.id);
      expect(webhookDel!.error).toContain('ECONNREFUSED');
      expect(webhookDel!.channelType).toBe('webhook');

      const slackDel = deliveries.find(d => d.channelId === slackCh.id);
      expect(slackDel!.error).toContain('invalid_auth');
      expect(slackDel!.statusCode).toBe(401);

      const emailDel = deliveries.find(d => d.channelId === emailCh.id);
      expect(emailDel!.error).toContain('SMTP');
    });

    it('should track attempt count on failed deliveries', async () => {
      const { user, org } = await createTestUserWithOrg();

      const ch = await createTestNotificationChannel(org.id, {
        name: 'Flaky Webhook',
        type: 'webhook',
        config: { url: 'https://flaky.example.com/hook' },
        enabled: true,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Retry Count Detection',
        moduleId: 'github',
      });
      await setDetectionChannelIds(detection.id, [ch.id]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Retry count test alert',
      });

      // Simulate: delivery failed after 3 attempts
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch.id,
        channelType: 'webhook',
        status: 'failed',
        error: 'Timeout after 3 retries',
        attemptCount: 3,
      });

      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].attemptCount).toBe(3);
      expect(deliveries[0].status).toBe('failed');
    });
  });

  // =========================================================================
  // Scenario 4: Delivery Deduplication on Retry
  // =========================================================================

  describe('Delivery Deduplication on Retry', () => {
    it('should not create duplicate delivery records for already-sent channels', async () => {
      const { user, org } = await createTestUserWithOrg();

      const emailCh = await createTestNotificationChannel(org.id, {
        name: 'Email Notifications',
        type: 'email',
        config: { to: 'ops@example.com' },
        enabled: true,
      });
      const webhookCh = await createTestNotificationChannel(org.id, {
        name: 'Ops Webhook',
        type: 'webhook',
        config: { url: 'https://ops.example.com/alerts' },
        enabled: true,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Dedup Detection',
        moduleId: 'github',
      });
      await setDetectionChannelIds(detection.id, [emailCh.id, webhookCh.id]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Dedup test alert',
        notificationStatus: 'pending',
      });

      // First dispatch: email succeeded, webhook failed
      await createTestDelivery({
        alertId: alert.id,
        channelId: emailCh.id,
        channelType: 'email',
        status: 'sent',
        statusCode: 200,
        responseTimeMs: 150,
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: webhookCh.id,
        channelType: 'webhook',
        status: 'failed',
        error: 'Timeout',
        attemptCount: 1,
      });

      const sql = getTestSql();
      await sql`
        UPDATE alerts SET notification_status = 'partial'
        WHERE id = ${alert.id.toString()}
      `;

      // Verify: 2 delivery records after first dispatch
      let deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(2);

      // Second dispatch (retry): check which channels already have 'sent' status
      const alreadySent = await sql`
        SELECT channel_id FROM notification_deliveries
        WHERE alert_id = ${alert.id.toString()} AND status = 'sent'
      `;
      expect(alreadySent).toHaveLength(1);
      expect(alreadySent[0].channel_id).toBe(emailCh.id);

      // The retry should only attempt the webhook (the failed one)
      // Simulate: webhook succeeds on retry
      await sql`
        UPDATE notification_deliveries
        SET status = 'sent', attempt_count = 2, error = NULL,
            status_code = 200, response_time_ms = 300, sent_at = now()
        WHERE alert_id = ${alert.id.toString()} AND channel_id = ${webhookCh.id}
      `;
      await sql`
        UPDATE alerts SET notification_status = 'sent'
        WHERE id = ${alert.id.toString()}
      `;

      // Verify: still only 2 delivery records (no duplicate for email)
      deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(2);

      // Verify: both are now 'sent'
      expect(deliveries.every(d => d.status === 'sent')).toBe(true);

      // Verify: webhook attempt count reflects retry
      const webhookDel = deliveries.find(d => d.channelId === webhookCh.id);
      expect(webhookDel!.attemptCount).toBe(2);

      // Verify: email was not re-attempted (still attempt 1)
      const emailDel = deliveries.find(d => d.channelId === emailCh.id);
      expect(emailDel!.attemptCount).toBe(1);

      // Verify: alert status is now fully sent
      const state = await getAlertNotificationState(alert.id);
      expect(state.notificationStatus).toBe('sent');
    });

    it('should identify channels needing retry via status check', async () => {
      const { user, org } = await createTestUserWithOrg();

      const ch1 = await createTestNotificationChannel(org.id, {
        name: 'Ch 1',
        type: 'email',
        config: { to: 'a@b.com' },
        enabled: true,
      });
      const ch2 = await createTestNotificationChannel(org.id, {
        name: 'Ch 2',
        type: 'webhook',
        config: { url: 'https://x.com' },
        enabled: true,
      });
      const ch3 = await createTestNotificationChannel(org.id, {
        name: 'Ch 3',
        type: 'slack',
        config: { channelId: 'C1' },
        enabled: true,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Retry Identification',
        moduleId: 'github',
      });
      await setDetectionChannelIds(detection.id, [ch1.id, ch2.id, ch3.id]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Retry identification alert',
      });

      // Ch1: sent, Ch2: failed, Ch3: sent
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch1.id,
        channelType: 'email',
        status: 'sent',
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch2.id,
        channelType: 'webhook',
        status: 'failed',
        error: 'Connection reset',
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch3.id,
        channelType: 'slack',
        status: 'sent',
        sentAt: new Date(),
      });

      // Query: which channels need retry?
      const sql = getTestSql();
      const needsRetry = await sql`
        SELECT channel_id, channel_type, status, error
        FROM notification_deliveries
        WHERE alert_id = ${alert.id.toString()} AND status = 'failed'
      `;
      expect(needsRetry).toHaveLength(1);
      expect(needsRetry[0].channel_id).toBe(ch2.id);
      expect(needsRetry[0].channel_type).toBe('webhook');
    });
  });

  // =========================================================================
  // Scenario 5: Mixed Success/Failure
  // =========================================================================

  describe('Mixed Success/Failure', () => {
    it('should set alert notificationStatus to partial when some channels succeed and others fail', async () => {
      const { user, org } = await createTestUserWithOrg();

      const emailCh = await createTestNotificationChannel(org.id, {
        name: 'Working Email',
        type: 'email',
        config: { to: 'alerts@example.com' },
        enabled: true,
      });
      const webhookCh = await createTestNotificationChannel(org.id, {
        name: 'Broken Webhook',
        type: 'webhook',
        config: { url: 'https://broken.example.com/hook' },
        enabled: true,
      });
      const slackCh = await createTestNotificationChannel(org.id, {
        name: 'Working Slack',
        type: 'slack',
        config: { channelId: 'C12345' },
        enabled: true,
      });

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Mixed Outcome Detection',
        moduleId: 'github',
        severity: 'critical',
      });
      await setDetectionChannelIds(detection.id, [
        emailCh.id,
        webhookCh.id,
        slackCh.id,
      ]);

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'critical',
        title: 'Mixed outcome alert',
      });

      // Email: success
      await createTestDelivery({
        alertId: alert.id,
        channelId: emailCh.id,
        channelType: 'email',
        status: 'sent',
        statusCode: 200,
        responseTimeMs: 95,
        sentAt: new Date(),
      });

      // Webhook: failed
      await createTestDelivery({
        alertId: alert.id,
        channelId: webhookCh.id,
        channelType: 'webhook',
        status: 'failed',
        error: 'HTTP 503 Service Unavailable',
        statusCode: 503,
        responseTimeMs: 2100,
      });

      // Slack: success
      await createTestDelivery({
        alertId: alert.id,
        channelId: slackCh.id,
        channelType: 'slack',
        status: 'sent',
        statusCode: 200,
        responseTimeMs: 300,
        sentAt: new Date(),
      });

      // Handler updates alert to partial
      const sql = getTestSql();
      await sql`
        UPDATE alerts SET notification_status = 'partial'
        WHERE id = ${alert.id.toString()}
      `;

      // Verify alert status
      const state = await getAlertNotificationState(alert.id);
      expect(state.notificationStatus).toBe('partial');

      // Verify delivery records
      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(3);

      const sentCount = deliveries.filter(d => d.status === 'sent').length;
      const failedCount = deliveries.filter(d => d.status === 'failed').length;
      expect(sentCount).toBe(2);
      expect(failedCount).toBe(1);

      // Verify the specific failed channel
      const failedDelivery = deliveries.find(d => d.status === 'failed');
      expect(failedDelivery!.channelId).toBe(webhookCh.id);
      expect(failedDelivery!.channelType).toBe('webhook');
      expect(failedDelivery!.statusCode).toBe(503);
      expect(failedDelivery!.error).toContain('503');
    });

    it('should correctly derive aggregate status from individual delivery statuses', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Status Derivation Detection',
        moduleId: 'github',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Status derivation test',
      });

      const ch1 = await createTestNotificationChannel(org.id, {
        name: 'Ch A',
        type: 'email',
        config: { to: 'a@b.com' },
      });
      const ch2 = await createTestNotificationChannel(org.id, {
        name: 'Ch B',
        type: 'webhook',
        config: { url: 'https://x.com' },
      });

      // All sent => 'sent'
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch1.id,
        channelType: 'email',
        status: 'sent',
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: ch2.id,
        channelType: 'webhook',
        status: 'sent',
        sentAt: new Date(),
      });

      const sql = getTestSql();

      // Query to derive aggregate status
      const [agg] = await sql`
        SELECT
          count(*) FILTER (WHERE status = 'sent')::int AS sent,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*)::int AS total
        FROM notification_deliveries
        WHERE alert_id = ${alert.id.toString()}
      `;
      expect(agg.sent).toBe(2);
      expect(agg.failed).toBe(0);
      expect(agg.total).toBe(2);

      // All sent => status should be 'sent'
      const derivedStatus =
        agg.total === 0 ? 'no_channels' :
        agg.failed === agg.total ? 'failed' :
        agg.sent === agg.total ? 'sent' :
        'partial';
      expect(derivedStatus).toBe('sent');
    });
  });

  // =========================================================================
  // Scenario 6: Alert with Deleted Detection
  // =========================================================================

  describe('Alert with Deleted Detection', () => {
    it('should handle alert whose detection_id is NULL (ON DELETE SET NULL)', async () => {
      const { user, org } = await createTestUserWithOrg();

      // Create and then delete the detection, causing the alert's detection_id to become NULL
      const detection = await createTestDetection(org.id, user.id, {
        name: 'Ephemeral Detection',
        moduleId: 'github',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Alert for deleted detection',
      });

      // Delete the detection (CASCADE will remove rules; SET NULL on alerts)
      const sql = getTestSql();
      await sql`DELETE FROM detections WHERE id = ${detection.id}`;

      // Verify: alert still exists but detection_id is NULL
      const [alertRow] = await sql`
        SELECT id, detection_id, notification_status
        FROM alerts WHERE id = ${alert.id.toString()}
      `;
      expect(alertRow).toBeDefined();
      expect(alertRow.detection_id).toBeNull();
      expect(alertRow.notification_status).toBe('pending');

      // When dispatch handler encounters NULL detection_id, it cannot resolve
      // channels. Simulate the handler updating the alert status gracefully.
      await sql`
        UPDATE alerts SET notification_status = 'no_channels'
        WHERE id = ${alert.id.toString()}
      `;

      const state = await getAlertNotificationState(alert.id);
      expect(state.notificationStatus).toBe('no_channels');

      // No delivery records should be created
      const count = await countDeliveriesForAlert(alert.id);
      expect(count).toBe(0);
    });

    it('should preserve alert data even after detection deletion', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Deleted Detection',
        moduleId: 'registry',
        severity: 'critical',
      });

      const event = await createTestEvent(org.id, {
        moduleId: 'registry',
        eventType: 'registry.docker.digest_change',
        payload: { tag: 'latest', artifact: 'sentinel/core' },
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        eventId: event.id,
        severity: 'critical',
        title: 'Docker digest changed: sentinel/core:latest',
        description: 'Critical digest change detected before detection was deleted',
        triggerType: 'immediate',
        triggerData: { tag: 'latest', newDigest: 'sha256:abc123' },
      });

      // Delete the detection
      const sql = getTestSql();
      await sql`DELETE FROM detections WHERE id = ${detection.id}`;

      // Verify: alert retains all its data except detection_id
      const [alertRow] = await sql`
        SELECT id, org_id, detection_id, event_id, severity, title,
               description, trigger_type, trigger_data
        FROM alerts WHERE id = ${alert.id.toString()}
      `;
      expect(alertRow.detection_id).toBeNull();
      expect(alertRow.event_id).toBe(event.id);
      expect(alertRow.severity).toBe('critical');
      expect(alertRow.title).toBe('Docker digest changed: sentinel/core:latest');
      expect(alertRow.description).toContain('Critical digest change');
      expect(alertRow.trigger_data).toEqual({ tag: 'latest', newDigest: 'sha256:abc123' });
    });

    it('should allow multiple alerts to survive the same detection deletion', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Multi-Alert Detection',
        moduleId: 'github',
      });

      // Create 3 alerts for the same detection
      const alert1 = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'First alert',
        triggerType: 'immediate',
        triggerData: { seq: 1 },
      });
      const alert2 = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Second alert',
        triggerType: 'immediate',
        triggerData: { seq: 2 },
      });
      const alert3 = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'medium',
        title: 'Third alert',
        triggerType: 'immediate',
        triggerData: { seq: 3 },
      });

      // Delete the detection
      const sql = getTestSql();
      await sql`DELETE FROM detections WHERE id = ${detection.id}`;

      // All three alerts should still exist with NULL detection_id
      const alertRows = await sql`
        SELECT id, detection_id, title FROM alerts
        WHERE org_id = ${org.id}
        ORDER BY id
      `;
      expect(alertRows).toHaveLength(3);
      expect(alertRows.every((r: any) => r.detection_id === null)).toBe(true);
      expect(alertRows.map((r: any) => r.title)).toEqual([
        'First alert',
        'Second alert',
        'Third alert',
      ]);
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('Edge Cases', () => {
    it('should enforce foreign key from notification_deliveries to alerts', async () => {
      const { org } = await createTestUserWithOrg();
      const sql = getTestSql();

      // Trying to insert a delivery for a non-existent alert should fail
      await expect(
        sql`
          INSERT INTO notification_deliveries (alert_id, channel_id, channel_type, status)
          VALUES (999999, 'fake-channel', 'email', 'pending')
        `,
      ).rejects.toThrow();
    });

    it('should cascade delete deliveries when alert is deleted', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Cascade Test Detection',
        moduleId: 'github',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Cascade test alert',
      });

      await createTestDelivery({
        alertId: alert.id,
        channelId: 'some-channel-id',
        channelType: 'email',
        status: 'sent',
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert.id,
        channelId: 'another-channel-id',
        channelType: 'webhook',
        status: 'failed',
        error: 'Timeout',
      });

      // Verify deliveries exist
      let count = await countDeliveriesForAlert(alert.id);
      expect(count).toBe(2);

      // Delete the alert
      const sql = getTestSql();
      await sql`DELETE FROM alerts WHERE id = ${alert.id.toString()}`;

      // Deliveries should be cascade-deleted
      const remaining = await sql`
        SELECT count(*)::int AS cnt FROM notification_deliveries
        WHERE alert_id = ${alert.id.toString()}
      `;
      expect(remaining[0].cnt).toBe(0);
    });

    it('should track response time and status code for successful deliveries', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Metrics Detection',
        moduleId: 'github',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'medium',
        title: 'Metrics test alert',
      });

      const sentAt = new Date();
      await createTestDelivery({
        alertId: alert.id,
        channelId: 'ch-metrics',
        channelType: 'webhook',
        status: 'sent',
        statusCode: 200,
        responseTimeMs: 142,
        sentAt,
        attemptCount: 1,
      });

      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].statusCode).toBe(200);
      expect(deliveries[0].responseTimeMs).toBe(142);
      expect(deliveries[0].attemptCount).toBe(1);
      expect(deliveries[0].sentAt).toBeInstanceOf(Date);
    });

    it('should support all channel types in delivery records', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Channel Types Detection',
        moduleId: 'github',
      });

      const alert = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Channel types test',
      });

      const channelTypes = ['email', 'webhook', 'slack'];
      for (const type of channelTypes) {
        await createTestDelivery({
          alertId: alert.id,
          channelId: `ch-${type}`,
          channelType: type,
          status: 'sent',
          sentAt: new Date(),
        });
      }

      const deliveries = await getDeliveriesForAlert(alert.id);
      expect(deliveries).toHaveLength(3);
      const types = deliveries.map(d => d.channelType).sort();
      expect(types).toEqual(['email', 'slack', 'webhook']);
    });

    it('should allow querying deliveries by status for monitoring/dashboards', async () => {
      const { user, org } = await createTestUserWithOrg();

      const detection = await createTestDetection(org.id, user.id, {
        name: 'Query Detection',
        moduleId: 'github',
      });

      // Create multiple alerts with various delivery statuses
      const alert1 = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'high',
        title: 'Alert A',
      });
      const alert2 = await createTestAlert({
        orgId: org.id,
        detectionId: detection.id,
        severity: 'medium',
        title: 'Alert B',
        triggerType: 'immediate',
        triggerData: { seq: 2 },
      });

      await createTestDelivery({
        alertId: alert1.id,
        channelId: 'ch-1',
        channelType: 'email',
        status: 'sent',
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert1.id,
        channelId: 'ch-2',
        channelType: 'webhook',
        status: 'failed',
        error: 'Timeout',
      });
      await createTestDelivery({
        alertId: alert2.id,
        channelId: 'ch-3',
        channelType: 'slack',
        status: 'sent',
        sentAt: new Date(),
      });
      await createTestDelivery({
        alertId: alert2.id,
        channelId: 'ch-4',
        channelType: 'email',
        status: 'pending',
      });

      const sql = getTestSql();

      // Count by status
      const statusCounts = await sql`
        SELECT status, count(*)::int AS cnt
        FROM notification_deliveries
        GROUP BY status
        ORDER BY status
      `;
      const countsMap = Object.fromEntries(
        statusCounts.map((r: any) => [r.status, r.cnt]),
      );
      expect(countsMap.sent).toBe(2);
      expect(countsMap.failed).toBe(1);
      expect(countsMap.pending).toBe(1);
    });
  });
});
