/**
 * Alert dispatch handler.
 * Loads the alert + detection channels, dispatches notifications.
 */
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { alerts, detections, notificationChannels, slackInstallations, notificationDeliveries } from '@sentinel/db/schema/core';
import { eq, and, inArray, isNull } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { decrypt } from '@sentinel/shared/crypto';
import { dispatchAlert, type ChannelRow } from '@sentinel/notifications/dispatcher';
import type { SlackAlertPayload } from '@sentinel/notifications/slack';
import type { DetectionModule } from '@sentinel/shared/module';

const AlertDispatchPayload = z.object({
  alertId: z.string().regex(/^\d+$/, 'alertId must be a numeric string'),
});

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

/**
 * Flatten triggerData into a label/value array for Slack formatters.
 * Walks one level deep into nested objects (e.g. repository.full_name).
 * Skips objects/arrays that aren't useful as display values.
 */
function flattenTriggerData(td: Record<string, unknown>): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, val] of Object.entries(td)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      fields.push({ label: key, value: String(val) });
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      // One level deep: e.g. repository.full_name, sender.login
      for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
        if (subVal === null || subVal === undefined) continue;
        if (typeof subVal === 'string' || typeof subVal === 'number' || typeof subVal === 'boolean') {
          fields.push({ label: `${key}.${subKey}`, value: String(subVal) });
        }
      }
    }
  }
  return fields;
}

export const alertDispatchHandler: JobHandler = {
  jobName: 'alert.dispatch',
  queueName: QUEUE_NAMES.ALERTS,

  async process(job: Job) {
    const parsed = AlertDispatchPayload.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError(`Invalid alert.dispatch payload: ${parsed.error.message}`);
    }
    const { alertId } = parsed.data;
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
          eq(notificationChannels.orgId, alert.orgId),
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
    const webUrl = process.env.WEB_URL;
    const td = (typeof alert.triggerData === 'object' && alert.triggerData !== null ? alert.triggerData : {}) as Record<string, unknown>;
    const alertPayload: SlackAlertPayload = {
      title: alert.title,
      severity: alert.severity,
      description: alert.description ?? undefined,
      module: typeof td.moduleId === 'string' ? td.moduleId : 'unknown',
      eventType: alert.triggerType,
      timestamp: (alert.createdAt instanceof Date ? alert.createdAt : new Date(String(alert.createdAt))).toISOString(),
      alertUrl: webUrl ? `${webUrl}/alerts/${alertId}` : undefined,
      fields: flattenTriggerData(td),
    };

    // Skip channels that already succeeded on a previous attempt.
    // Delivery records store the notification channel UUID for configured channels
    // and the Slack workspace channel ID (e.g. C0XXXXXX) for direct Slack dispatches.
    // Track each population separately so the lookups use the correct ID type.
    const previousDeliveries = await db.select({ channelId: notificationDeliveries.channelId })
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.alertId, BigInt(alertId)),
        eq(notificationDeliveries.status, 'sent'),
      ));
    // UUIDs of notification channels that were already delivered successfully.
    const alreadySent = new Set(previousDeliveries.map((d) => d.channelId));
    channels = channels.filter((c) => !alreadySent.has(c.id));

    // If the direct Slack channel was already sent, skip it.
    // Use detection.slackChannelId (the Slack workspace channel ID) directly,
    // because that is the value stored as channelId in the delivery record for
    // the direct Slack path — NOT a notification channel UUID.
    const skipDirectSlack = detection?.slackChannelId
      ? alreadySent.has(detection.slackChannelId)
      : false;

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

    // Write delivery records and update the alert status atomically.
    // Inserting deliveries first (before the status update) ensures that a crash
    // between the two writes cannot leave the alert marked 'sent' with no audit
    // trail. Wrapping both in a transaction ensures either all delivery rows and
    // the status update commit together, or none do — preventing partial delivery
    // records on retry.
    await db.transaction(async (tx) => {
      if (results.length > 0) {
        await tx.insert(notificationDeliveries).values(
          results.map((result) => ({
            alertId: BigInt(alertId),
            channelId: result.channelId,
            channelType: result.type,
            status: result.status,
            statusCode: result.statusCode ?? null,
            responseTimeMs: result.responseTimeMs ?? null,
            error: result.error ?? null,
            sentAt: result.status === 'sent' ? new Date() : null,
          })),
        );
      }

      await tx.update(alerts)
        .set({ notificationStatus: status, notifications: results })
        .where(eq(alerts.id, BigInt(alertId)));
    });
  },
};
