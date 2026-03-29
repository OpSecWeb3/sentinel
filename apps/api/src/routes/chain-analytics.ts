/**
 * Chain module analytics routes — read-only blockchain intelligence for MCP tools.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, lte, sql, desc } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { chainStateSnapshots, chainBlockCursors, chainRpcUsageHourly, chainNetworks } from '@sentinel/db/schema/chain';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// GET /chain/address-activity — on-chain events for an address
// ---------------------------------------------------------------------------

const addressActivitySchema = z.object({
  address: z.string().min(1),
  networkId: z.coerce.number().int().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/address-activity', requireScope('api:read'), validate('query', addressActivitySchema), async (c) => {
  const query = getValidated<z.infer<typeof addressActivitySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [
    eq(events.orgId, orgId),
    eq(events.moduleId, 'chain'),
    sql`${events.payload}->>'address' = ${query.address}`,
  ];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));
  if (query.networkId) conditions.push(sql`(${events.payload}->>'networkId')::int = ${query.networkId}`);

  const rows = await db.select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt))
    .limit(query.limit);

  return c.json({ address: query.address, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /chain/balance-history — balance snapshot history
// ---------------------------------------------------------------------------

const balanceHistorySchema = z.object({
  ruleId: z.string().uuid().optional(),
  address: z.string().optional(),
  networkId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

router.get('/balance-history', requireScope('api:read'), validate('query', balanceHistorySchema), async (c) => {
  const query = getValidated<z.infer<typeof balanceHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(chainStateSnapshots.snapshotType, 'balance')];
  if (query.ruleId) conditions.push(eq(chainStateSnapshots.ruleId, query.ruleId));
  if (query.address) conditions.push(eq(chainStateSnapshots.address, query.address));
  if (query.networkId) conditions.push(eq(chainStateSnapshots.networkId, query.networkId));

  // Scope to org via rules join — rules.org_id = orgId
  conditions.push(sql`EXISTS (SELECT 1 FROM rules WHERE rules.id = ${chainStateSnapshots.ruleId} AND rules.org_id = ${orgId})`);

  const rows = await db.select()
    .from(chainStateSnapshots)
    .where(and(...conditions))
    .orderBy(desc(chainStateSnapshots.polledAt))
    .limit(query.limit);

  return c.json({ count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /chain/state-history — storage slot value timeline
// ---------------------------------------------------------------------------

const stateHistorySchema = z.object({
  ruleId: z.string().uuid().optional(),
  address: z.string().optional(),
  slot: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

router.get('/state-history', requireScope('api:read'), validate('query', stateHistorySchema), async (c) => {
  const query = getValidated<z.infer<typeof stateHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(chainStateSnapshots.snapshotType, 'storage')];
  if (query.ruleId) conditions.push(eq(chainStateSnapshots.ruleId, query.ruleId));
  if (query.address) conditions.push(eq(chainStateSnapshots.address, query.address));
  if (query.slot) conditions.push(eq(chainStateSnapshots.slot, query.slot));
  conditions.push(sql`EXISTS (SELECT 1 FROM rules WHERE rules.id = ${chainStateSnapshots.ruleId} AND rules.org_id = ${orgId})`);

  const rows = await db.select()
    .from(chainStateSnapshots)
    .where(and(...conditions))
    .orderBy(desc(chainStateSnapshots.polledAt))
    .limit(query.limit);

  return c.json({ count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /chain/network-status — block cursor positions per network
// ---------------------------------------------------------------------------

router.get('/network-status', requireScope('api:read'), requireRole('admin'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  // Scope to networks the org monitors — i.e. networks that have at least one
  // contract registered by this org, or that appear in the org's RPC usage.
  const rows = await db
    .select({
      networkId: chainBlockCursors.networkId,
      lastBlock: chainBlockCursors.lastBlock,
      updatedAt: chainBlockCursors.updatedAt,
      networkName: chainNetworks.name,
      networkSlug: chainNetworks.slug,
      chainId: chainNetworks.chainId,
      isActive: chainNetworks.isActive,
    })
    .from(chainBlockCursors)
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainBlockCursors.networkId))
    .where(sql`EXISTS (
      SELECT 1 FROM chain_org_contracts oc
      JOIN chain_contracts cc ON cc.id = oc.contract_id
      WHERE cc.network_id = ${chainBlockCursors.networkId}
        AND oc.org_id = ${orgId}
    )`)
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /chain/rpc-usage — hourly RPC call counts
// ---------------------------------------------------------------------------

const rpcUsageSchema = z.object({
  networkId: z.coerce.number().int().optional(),
  since: z.string().datetime().optional(),
});

router.get('/rpc-usage', requireScope('api:read'), validate('query', rpcUsageSchema), async (c) => {
  const query = getValidated<z.infer<typeof rpcUsageSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(chainRpcUsageHourly.orgId, orgId)];
  if (query.since) conditions.push(gte(chainRpcUsageHourly.bucket, new Date(query.since)));
  if (query.networkId !== undefined) {
    // Join to get networkSlug
    const [network] = await db.select({ slug: chainNetworks.slug })
      .from(chainNetworks)
      .where(eq(chainNetworks.id, query.networkId))
      .limit(1);
    if (network) conditions.push(eq(chainRpcUsageHourly.networkSlug, network.slug));
  }

  const rows = await db.select()
    .from(chainRpcUsageHourly)
    .where(and(...conditions))
    .orderBy(desc(chainRpcUsageHourly.bucket))
    .limit(1000);

  return c.json({ data: rows });
});

export { router as chainAnalyticsRouter };
