/**
 * Module metadata route.
 * Returns all registered modules with their event type definitions.
 * Used by the correlation rule form to populate dynamic dropdowns.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, sql } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { eq, and, desc } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import type { DetectionModule } from '@sentinel/shared/module';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// Module references are injected at startup via setModules().
// null means setModules() has never been called (misconfiguration); [] is a
// valid (but unusual) state where the host deliberately registered no modules.
let registeredModules: DetectionModule[] | null = null;

export function setModules(modules: DetectionModule[]) {
  registeredModules = modules;
}

// ---------------------------------------------------------------------------
// GET /modules/metadata — all modules with event type definitions
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), async (c) => {
  if (registeredModules === null) {
    return c.json({ error: 'Module registry not initialised — server misconfiguration' }, 503);
  }

  const data = registeredModules.map((mod) => ({
    id: mod.id,
    name: mod.name,
    eventTypes: mod.eventTypes.map((et) => ({
      type: et.type,
      label: et.label,
      description: et.description,
    })),
  }));

  return c.json({ data });
});

// ---------------------------------------------------------------------------
// GET /modules/metadata/sample-fields — extract field paths from a sample event
// ---------------------------------------------------------------------------

const sampleFieldsSchema = z.object({
  moduleId: z.string().min(1),
  eventType: z.string().min(1),
});

// Maximum nesting depth when extracting field paths from an event payload.
// Defined at module scope so it is not recreated on every request.
const MAX_DEPTH = 6;

router.get('/sample-fields', requireScope('api:read'), validate('query', sampleFieldsSchema), async (c) => {
  const query = getValidated<z.infer<typeof sampleFieldsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  // Fetch one recent event of this type to extract its payload structure
  const [sample] = await db.select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.moduleId, query.moduleId),
        eq(events.eventType, query.eventType),
      ),
    )
    .orderBy(desc(events.receivedAt))
    .limit(1);

  if (!sample) {
    return c.json({ data: { fields: [], hasData: false } });
  }

  // Recursively extract all field paths from the payload
  const fields: Array<{ path: string; type: string; sample: unknown }> = [];

  function extractPaths(obj: unknown, prefix: string, depth = 0) {
    if (depth > MAX_DEPTH) return;
    if (obj === null || obj === undefined) return;
    if (typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      fields.push({ path: prefix, type: 'array', sample: obj.length > 0 ? `[${obj.length} items]` : '[]' });
      return;
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        fields.push({ path, type: 'null', sample: null });
      } else if (typeof value === 'string') {
        fields.push({ path, type: 'string', sample: value.length > 80 ? value.slice(0, 80) + '…' : value });
      } else if (typeof value === 'number') {
        fields.push({ path, type: 'number', sample: value });
      } else if (typeof value === 'boolean') {
        fields.push({ path, type: 'boolean', sample: value });
      } else if (Array.isArray(value)) {
        fields.push({ path, type: 'array', sample: value.length > 0 ? `[${value.length} items]` : '[]' });
      } else if (typeof value === 'object') {
        extractPaths(value, path, depth + 1);
      }
    }
  }

  extractPaths(sample.payload, '');

  return c.json({ data: { fields, hasData: true } });
});

export { router as modulesMetadataRouter };
