/**
 * GET /api/field-catalog — returns discovered payload field paths.
 * Used by the query builder for autocomplete.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, sql, eq, and } from '@sentinel/db';
import { payloadFieldCatalog } from '@sentinel/db/schema/core';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

const querySchema = z.object({
  source: z.enum(['events', 'alerts']).optional(),
  sourceType: z.string().optional(),
});

router.get('/', requireScope('api:read'), validate('query', querySchema), async (c) => {
  const query = getValidated<z.infer<typeof querySchema>>(c, 'query');
  const db = getDb();

  const conditions = [];
  if (query.source) conditions.push(eq(payloadFieldCatalog.source, query.source));
  if (query.sourceType) conditions.push(eq(payloadFieldCatalog.sourceType, query.sourceType));

  const rows = await db
    .select({
      source: payloadFieldCatalog.source,
      sourceType: payloadFieldCatalog.sourceType,
      fieldPath: payloadFieldCatalog.fieldPath,
      fieldType: payloadFieldCatalog.fieldType,
      lastSeenAt: payloadFieldCatalog.lastSeenAt,
    })
    .from(payloadFieldCatalog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(payloadFieldCatalog.source, payloadFieldCatalog.sourceType, payloadFieldCatalog.fieldPath);

  return c.json({ data: rows });
});

export { router as fieldCatalogRouter };
