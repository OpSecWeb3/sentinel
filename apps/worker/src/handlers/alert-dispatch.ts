/**
 * Alert dispatch handler.
 * Loads the alert + detection channels, dispatches notifications.
 */
import type { Job } from 'bullmq';
import { getDb } from '@sentinel/db';
import { alerts, detections, notificationChannels, slackInstallations, notificationDeliveries } from '@sentinel/db/schema/core';
import { eq, and, inArray, isNull } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { decrypt } from '@sentinel/shared/crypto';
import { dispatchAlert, type ChannelRow } from '@sentinel/notifications/dispatcher';
import type { SlackAlertPayload } from '@sentinel/notifications/slack';
import type { DetectionModule } from '@sentinel/shared/module';

/** Module formatter registry — set by the worker at startup */
let moduleFormatters: Map<string, DetectionModule['formatSlackBlocks']> | undefined;

export function setModuleFormatters(modules: DetectionModule[]): void {
  moduleFormatters = new Map();
  for (const mod of modules) {
    if (mod.formatSlackBlocks) {
      moduleFormatters.set(mod.id, mod.formatSlackBlocks);
    }
  }
}

export const alertDispatchHandler: JobHandler = {
  jobName: 'alert.dispatch',
  queueName: QUEUE_NAMES.ALERTS,

  async process(job: Job) {
    const { alertId } = job.data as { alertId: string };
    const db = getDb();

    // Load alert
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, BigInt(alertId))).limit(1);
    if (!alert) return;

    // Load detection (for channel config)
    let detection = null;
    if (alert.detectionId) {
      const [det] = await db.select().from(detections).where(eq(detections.id, alert.detectionId)).limit(1);
      detection = det ?? null;
    }

    // Load notification channels
    const channelIds = detection?.channelIds ?? [];
    let channels: ChannelRow[] = [];
    if (channelIds.length > 0) {
      const rows = await db.select({
        id: notificationChannels.id,
        type: notificationChannels.type,
        config: notificationChannels.config,
      })
        .from(notificationChannels)
        .where(and(
          inArray(notificationChannels.id, channelIds),
          eq(notificationChannels.enabled, true),
          isNull(notificationChannels.deletedAt),
        ));
      channels = rows.map((r) => ({
        ...r,
        config: r.config as Record<string, unknown>,
      }));
    }

    // Load Slack bot token if direct Slack channel configured
    let slackBotToken: string | null = null;
    if (detection?.slackChannelId) {
      const [installation] = await db.select({ botToken: slackInstallations.botToken })
        .from(slackInstallations)
        .where(eq(slackInstallations.orgId, alert.orgId))
        .limit(1);

      if (installation) {
        slackBotToken = decrypt(installation.botToken);
      }
    }

    // Build alert payload
    const alertPayload: SlackAlertPayload = {
      title: alert.title,
      severity: alert.severity,
      description: alert.description ?? undefined,
      module: (alert.triggerData as Record<string, unknown>)?.moduleId as string ?? 'unknown',
      eventType: alert.triggerType,
      timestamp: new Date(alert.createdAt).toISOString(),
    };

    // Skip channels that already succeeded on a previous attempt
    const previousDeliveries = await db.select({ channelId: notificationDeliveries.channelId })
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.alertId, BigInt(alertId)),
        eq(notificationDeliveries.status, 'sent'),
      ));
    const alreadySent = new Set(previousDeliveries.map((d) => d.channelId));
    channels = channels.filter((c) => !alreadySent.has(c.id));

    // If the direct Slack channel was already sent, skip it
    const skipDirectSlack = detection?.slackChannelId ? alreadySent.has(detection.slackChannelId) : false;

    // Resolve module-specific Slack formatter
    const moduleId = alertPayload.module;
    const formatBlocks = moduleFormatters?.get(moduleId) ?? undefined;

    // Dispatch
    const results = await dispatchAlert(
      channels,
      alertPayload,
      skipDirectSlack ? null : slackBotToken,
      skipDirectSlack ? null : detection?.slackChannelId,
      formatBlocks,
    );

    // Update alert with notification results
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const status = results.length === 0
      ? (alreadySent.size > 0 ? 'sent' : 'no_channels')
      : failedCount === 0
        ? 'sent'
        : failedCount === results.length
          ? 'failed'
          : 'partial';

    await db.update(alerts)
      .set({ notificationStatus: status, notifications: results })
      .where(eq(alerts.id, BigInt(alertId)));

    // Write per-channel delivery records
    for (const result of results) {
      await db.insert(notificationDeliveries).values({
        alertId: BigInt(alertId),
        channelId: result.channelId,
        channelType: result.type,
        status: result.status,
        statusCode: result.statusCode ?? null,
        responseTimeMs: result.responseTimeMs ?? null,
        error: result.error ?? null,
        sentAt: result.status === 'sent' ? new Date() : null,
      });
    }
  },
};
