/**
 * Audit log query endpoint.
 * Provides paginated, filterable read access to the audit trail.
 * Admin-only — org-scoped.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, desc, gte, lte } from '@sentinel/db';
import { auditLog } from '@sentinel/db/schema/core';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { validate, getValidated } from '../middleware/validate.js';
import type { AppEnv } from '@sentinel/shared/hono-types';

const auditLogRouter = new Hono<AppEnv>();
auditLogRouter.use('*', requireAuth, requireOrg);

const auditLogQuerySchema = z.object({
  action: z.string().max(255).optional(),
  resourceType: z.string().max(255).optional(),
  userId: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

auditLogRouter.get('/', requireRole('admin'), validate('query', auditLogQuerySchema), async (c) => {
  const orgId = c.get('orgId')!;
  const db = getDb();

  const query = getValidated<z.infer<typeof auditLogQuerySchema>>(c, 'query');
  const { action, resourceType, userId, since, until, limit, offset } = query;

  const conditions: ReturnType<typeof eq>[] = [eq(auditLog.orgId, orgId)];
  if (action) conditions.push(eq(auditLog.action, action));
  if (resourceType) conditions.push(eq(auditLog.resourceType, resourceType));
  if (userId) conditions.push(eq(auditLog.userId, userId));
  if (since) conditions.push(gte(auditLog.createdAt, new Date(since)));
  if (until) conditions.push(lte(auditLog.createdAt, new Date(until)));

  const rows = await db.select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: rows, limit, offset });
});

export { auditLogRouter };
