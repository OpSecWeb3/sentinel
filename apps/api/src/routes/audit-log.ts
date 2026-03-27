/**
 * Audit log query endpoint.
 * Provides paginated, filterable read access to the audit trail.
 * Admin-only — org-scoped.
 */
import { Hono } from 'hono';
import { getDb } from '@sentinel/db';
import { eq, and, desc, gte, lte } from '@sentinel/db';
import { auditLog } from '@sentinel/db/schema/core';
import { requireRole } from '../middleware/rbac.js';
import type { AppEnv } from '@sentinel/shared/hono-types';

const auditLogRouter = new Hono<AppEnv>();

auditLogRouter.get('/', requireRole('admin'), async (c) => {
  const orgId = c.get('orgId')!;
  const db = getDb();

  // Query params
  const action = c.req.query('action');
  const resourceType = c.req.query('resourceType');
  const userId = c.req.query('userId');
  const since = c.req.query('since');
  const until = c.req.query('until');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const offset = Number(c.req.query('offset')) || 0;

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
