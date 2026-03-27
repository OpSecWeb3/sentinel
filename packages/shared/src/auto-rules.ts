/**
 * Auto-create detections from a module's default templates when a
 * monitored resource is first registered.
 *
 * Fire-and-forget: errors are logged, never thrown to the caller.
 */
import type { DetectionModule, DetectionTemplate } from './module.js';
import { logger as rootLogger, type Logger } from './logger.js';

export interface AutoRuleDb {
  transaction<T>(fn: (tx: AutoRuleTx) => Promise<T>): Promise<T>;
}

export interface AutoRuleTx {
  insert(table: unknown): { values(v: unknown): { returning(): Promise<unknown[]> } };
}

/**
 * Create detections + rules from a module's defaultTemplates.
 * Returns IDs of created detections.
 */
export async function autoCreateDetections(
  module: DetectionModule,
  orgId: string,
  resourceLabel: string,
  db: {

    transaction: <T>(fn: (tx: {
      insert: (table: unknown) => {
        values: (v: unknown) => { returning: () => Promise<unknown[]> };
      };
    }) => Promise<T>) => Promise<T>;
  },
  tables: {
    detections: unknown;
    rules: unknown;
  },
  log?: Logger,
): Promise<string[]> {
  const _log = log ?? rootLogger.child({ component: 'auto-rules' });
  const slugs = module.defaultTemplates ?? [];
  if (slugs.length === 0) return [];

  const createdIds: string[] = [];

  for (const slug of slugs) {
    const template = module.templates.find((t) => t.slug === slug);
    if (!template) {
      _log.warn({ slug, moduleId: module.id }, 'Template not found in module');
      continue;
    }

    try {
      const result = await db.transaction(async (tx: any) => {
        const [detection] = await tx.insert(tables.detections).values({
          orgId,
          createdBy: null,
          moduleId: module.id,
          templateId: template.slug,
          name: `${template.name} — ${resourceLabel}`,
          description: template.description,
          severity: template.severity,
          channelIds: [],
          cooldownMinutes: 5,
          config: {},
        }).returning();

        await tx.insert(tables.rules).values(
          template.rules.map((r) => ({
            detectionId: detection.id,
            orgId,
            moduleId: module.id,
            ruleType: r.ruleType,
            config: r.config,
            action: r.action,
            priority: r.priority ?? 50,
          })),
        ).returning();

        return detection;
      });

      createdIds.push((result as { id: string }).id);
    } catch (err) {
      _log.error({ err, slug }, 'Failed to create detection from template');
    }
  }

  return createdIds;
}
