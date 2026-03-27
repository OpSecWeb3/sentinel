/**
 * Chain module Hono router.
 *
 * Provides REST endpoints for managing blockchain networks, contracts,
 * RPC configurations, and querying state change history. Follows the
 * same router pattern as the GitHub and release-chain modules.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gte, lte, count, sql, ne } from '@sentinel/db';
import { getDb } from '@sentinel/db';
import {
  chainNetworks,
  chainContracts,
  chainOrgContracts,
  chainOrgRpcConfigs,
  chainStateSnapshots,
  chainBlockCursors,
  chainRpcUsageHourly,
} from '@sentinel/db/schema/chain';
import { detections, alerts, events } from '@sentinel/db/schema/core';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { templates as chainTemplates } from './templates/index.js';

export const chainRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// GET /modules/chain/overview — aggregated stats for the chain dashboard
// ---------------------------------------------------------------------------

chainRouter.get('/overview', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  const [
    [contractsRow],
    [detectionsRow],
    [alertsRow],
    [eventsRow],
    networks,
    recentEvents,
  ] = await Promise.all([
    db.select({ total: count() }).from(chainOrgContracts).where(eq(chainOrgContracts.orgId, orgId)),
    db.select({ total: count() }).from(detections).where(and(eq(detections.orgId, orgId), eq(detections.moduleId, 'chain'), ne(detections.status, 'disabled'))),
    db.select({ total: count() }).from(alerts).innerJoin(detections, eq(detections.id, alerts.detectionId)).where(and(eq(detections.orgId, orgId), eq(detections.moduleId, 'chain'), gte(alerts.createdAt, new Date(Date.now() - 7 * 86_400_000)))),
    db.select({ total: count() }).from(events).where(and(eq(events.orgId, orgId), eq(events.moduleId, 'chain'))),
    db.select({
      id: chainNetworks.id,
      name: chainNetworks.name,
      chainId: chainNetworks.chainId,
      currentBlock: chainBlockCursors.lastBlock,
      pollingActive: chainNetworks.isActive,
      lastPolledAt: chainBlockCursors.updatedAt,
    })
      .from(chainNetworks)
      .leftJoin(chainBlockCursors, eq(chainBlockCursors.networkId, chainNetworks.id))
      .orderBy(chainNetworks.name),
    db.select({
      id: events.id,
      eventName: events.eventType,
      contractAddress: sql<string>`(events.payload->>'address')::text`.as('contract_address'),
      networkName: sql<string>`(events.payload->>'network')::text`.as('network_name'),
      blockNumber: sql<number>`((events.payload->>'blockNumber')::bigint)::int`.as('block_number'),
      txHash: sql<string>`(events.payload->>'transactionHash')::text`.as('tx_hash'),
      createdAt: events.receivedAt,
    })
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.moduleId, 'chain')))
      .orderBy(desc(events.receivedAt))
      .limit(10),
  ]);

  return c.json({
    stats: {
      trackedContracts: contractsRow?.total ?? 0,
      activeDetections: detectionsRow?.total ?? 0,
      recentAlerts: alertsRow?.total ?? 0,
      totalEvents: eventsRow?.total ?? 0,
    },
    networks: networks.map((n) => ({
      id: n.id,
      name: n.name,
      chainId: n.chainId,
      currentBlock: n.currentBlock ?? 0,
      pollingActive: n.pollingActive ?? false,
      lastPolledAt: n.lastPolledAt?.toISOString() ?? null,
    })),
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      eventName: e.eventName,
      contractAddress: e.contractAddress ?? '',
      networkName: e.networkName ?? '',
      blockNumber: e.blockNumber ?? 0,
      txHash: e.txHash ?? '',
      createdAt: e.createdAt?.toISOString() ?? new Date().toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /modules/chain/templates -- list detection templates for the chain module
// ---------------------------------------------------------------------------

chainRouter.get('/templates', (c) => {
  const search = c.req.query('search')?.toLowerCase();
  const data = chainTemplates
    .filter((t) => !search || t.name.toLowerCase().includes(search) || t.description.toLowerCase().includes(search))
    .map((t) => ({
      id: t.slug,
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      severity: t.severity,
      ruleCount: Array.isArray(t.rules) ? t.rules.length : 0,
      inputs: [],
    }));
  return c.json({ data, meta: { total: data.length } });
});

// ---------------------------------------------------------------------------
// GET /modules/chain/networks -- list supported networks
// ---------------------------------------------------------------------------

chainRouter.get('/networks', async (c) => {
  const db = getDb();

  const rows = await db
    .select({
      id: chainNetworks.id,
      name: chainNetworks.name,
      slug: chainNetworks.slug,
      chainKey: chainNetworks.chainKey,
      chainId: chainNetworks.chainId,
      blockTimeMs: chainNetworks.blockTimeMs,
      explorerUrl: chainNetworks.explorerUrl,
      isActive: chainNetworks.isActive,
    })
    .from(chainNetworks)
    .where(eq(chainNetworks.isActive, true));

  // Attach block cursor info for each network
  const cursors = await db.select().from(chainBlockCursors);
  const cursorMap = new Map(cursors.map((cur) => [cur.networkId, cur]));

  const data = rows.map((n) => {
    const cursor = cursorMap.get(n.id);
    return {
      ...n,
      lastBlock: cursor?.lastBlock?.toString() ?? null,
      lastBlockUpdatedAt: cursor?.updatedAt ?? null,
    };
  });

  return c.json({ data });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/networks -- add network (admin)
// ---------------------------------------------------------------------------

const createNetworkSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  chainKey: z.string().min(1).optional(),
  chainId: z.coerce.number().int().positive(),
  rpcUrl: z.string().min(1).optional(),
  blockTimeMs: z.coerce.number().int().min(100).default(12000),
  explorerUrl: z.string().url().optional(),
  explorerApi: z.string().url().optional(),
});

chainRouter.post('/networks', async (c) => {
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = createNetworkSchema.parse(await c.req.json());
  const db = getDb();

  const autoSlug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const autoChainKey = body.chainKey ?? autoSlug;

  const [network] = await db
    .insert(chainNetworks)
    .values({
      name: body.name,
      slug: autoSlug,
      chainKey: autoChainKey,
      chainId: body.chainId,
      rpcUrl: body.rpcUrl ?? '',
      blockTimeMs: body.blockTimeMs,
      explorerUrl: body.explorerUrl ?? null,
      explorerApi: body.explorerApi ?? null,
    })
    .returning();

  return c.json({ data: network }, 201);
});

// ---------------------------------------------------------------------------
// GET /modules/chain/contracts -- list org contracts
// ---------------------------------------------------------------------------

chainRouter.get('/contracts', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  const rows = await db
    .select({
      id: chainOrgContracts.id,
      contractId: chainOrgContracts.contractId,
      label: chainOrgContracts.label,
      tags: chainOrgContracts.tags,
      notes: chainOrgContracts.notes,
      createdAt: chainOrgContracts.createdAt,
      // Contract details
      address: chainContracts.address,
      name: chainContracts.name,
      networkId: chainContracts.networkId,
      isProxy: chainContracts.isProxy,
      implementation: chainContracts.implementation,
      traits: chainContracts.traits,
      fetchedAt: chainContracts.fetchedAt,
      // Network details
      networkName: chainNetworks.name,
      networkSlug: chainNetworks.slug,
      chainId: chainNetworks.chainId,
    })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(eq(chainOrgContracts.orgId, orgId));

  return c.json({ data: rows, meta: { total: rows.length } });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/contracts -- add contract (with ABI fetch from explorer)
// ---------------------------------------------------------------------------

const addContractSchema = z.object({
  networkSlug: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  label: z.string().min(1),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  abi: z.unknown().optional(), // Caller can supply ABI; otherwise we fetch from explorer
});

chainRouter.post('/contracts', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (!userId) return c.json({ error: 'User context required' }, 403);

  const body = addContractSchema.parse(await c.req.json());
  const db = getDb();

  // Resolve network
  const [network] = await db
    .select()
    .from(chainNetworks)
    .where(eq(chainNetworks.slug, body.networkSlug))
    .limit(1);

  if (!network) {
    return c.json({ error: `Unknown network: ${body.networkSlug}` }, 400);
  }

  const normalizedAddress = body.address.toLowerCase();

  // Upsert the global contract record
  const [contract] = await db
    .insert(chainContracts)
    .values({
      networkId: network.id,
      address: normalizedAddress,
      name: body.label,
      abi: body.abi ?? {},
    })
    .onConflictDoUpdate({
      target: [chainContracts.networkId, chainContracts.address],
      set: {
        name: body.label,
        ...(body.abi ? { abi: body.abi } : {}),
      },
    })
    .returning();

  // Create org-scoped contract link
  const [orgContract] = await db
    .insert(chainOrgContracts)
    .values({
      orgId,
      contractId: contract.id,
      label: body.label,
      tags: body.tags,
      notes: body.notes ?? null,
      addedBy: userId,
    })
    .onConflictDoUpdate({
      target: [chainOrgContracts.orgId, chainOrgContracts.contractId],
      set: {
        label: body.label,
        tags: body.tags,
        notes: body.notes ?? null,
      },
    })
    .returning();

  // If no ABI was provided, schedule a verification job to fetch from explorer
  if (!body.abi || (typeof body.abi === 'object' && Object.keys(body.abi as object).length === 0)) {
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await queue.add('chain.contract.verify', {
      contractId: contract.id,
      networkSlug: body.networkSlug,
      address: normalizedAddress,
    });
  }

  return c.json(
    {
      data: {
        id: orgContract.id,
        contractId: contract.id,
        address: normalizedAddress,
        label: body.label,
        networkSlug: body.networkSlug,
        chainId: network.chainId,
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /modules/chain/contracts/:id -- contract detail with ABI
// ---------------------------------------------------------------------------

chainRouter.get('/contracts/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const contractId = Number(c.req.param('id'));
  if (!Number.isFinite(contractId)) {
    return c.json({ error: 'Invalid contract ID' }, 400);
  }

  const db = getDb();

  const [row] = await db
    .select({
      id: chainOrgContracts.id,
      contractId: chainOrgContracts.contractId,
      label: chainOrgContracts.label,
      tags: chainOrgContracts.tags,
      notes: chainOrgContracts.notes,
      createdAt: chainOrgContracts.createdAt,
      // Contract details
      address: chainContracts.address,
      name: chainContracts.name,
      abi: chainContracts.abi,
      isProxy: chainContracts.isProxy,
      implementation: chainContracts.implementation,
      traits: chainContracts.traits,
      fetchedAt: chainContracts.fetchedAt,
      storageLayout: chainContracts.storageLayout,
      layoutStatus: chainContracts.layoutStatus,
      // Network details
      networkId: chainContracts.networkId,
      networkName: chainNetworks.name,
      networkSlug: chainNetworks.slug,
      chainId: chainNetworks.chainId,
      explorerUrl: chainNetworks.explorerUrl,
    })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(
      and(
        eq(chainOrgContracts.contractId, contractId),
        eq(chainOrgContracts.orgId, orgId),
      ),
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Contract not found' }, 404);
  }

  return c.json({ data: row });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/contracts/:id/verify -- fetch/verify ABI from explorer
// ---------------------------------------------------------------------------

chainRouter.post('/contracts/:id/verify', async (c) => {
  const orgId = c.get('orgId');
  const contractId = parseInt(c.req.param('id'), 10);
  if (isNaN(contractId)) return c.json({ error: 'Invalid contract ID' }, 400);

  const db = getDb();

  // Verify org ownership
  const [orgContract] = await db
    .select({ networkSlug: chainNetworks.slug, address: chainContracts.address })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(and(eq(chainOrgContracts.contractId, contractId), eq(chainOrgContracts.orgId, orgId)))
    .limit(1);

  if (!orgContract) return c.json({ error: 'Contract not found' }, 404);

  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('chain.contract.verify', {
    contractId,
    networkSlug: orgContract.networkSlug,
    address: orgContract.address,
  });

  return c.json({ status: 'queued' }, 202);
});

// ---------------------------------------------------------------------------
// GET /modules/chain/rpc-configs -- org RPC configs
// ---------------------------------------------------------------------------

chainRouter.get('/rpc-configs', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  const rows = await db
    .select({
      id: chainOrgRpcConfigs.id,
      networkId: chainOrgRpcConfigs.networkId,
      rpcUrl: chainOrgRpcConfigs.rpcUrl,
      isActive: chainOrgRpcConfigs.isActive,
      createdAt: chainOrgRpcConfigs.createdAt,
      updatedAt: chainOrgRpcConfigs.updatedAt,
      // Network details
      networkName: chainNetworks.name,
      networkSlug: chainNetworks.slug,
      chainId: chainNetworks.chainId,
    })
    .from(chainOrgRpcConfigs)
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainOrgRpcConfigs.networkId))
    .where(eq(chainOrgRpcConfigs.orgId, orgId));

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/rpc-configs -- set custom RPC for a network
// ---------------------------------------------------------------------------

const setRpcConfigSchema = z.object({
  networkSlug: z.string().min(1),
  rpcUrl: z.string().url(),
  isActive: z.boolean().default(true),
});

chainRouter.post('/rpc-configs', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = setRpcConfigSchema.parse(await c.req.json());
  const db = getDb();

  // Resolve network
  const [network] = await db
    .select({ id: chainNetworks.id })
    .from(chainNetworks)
    .where(eq(chainNetworks.slug, body.networkSlug))
    .limit(1);

  if (!network) {
    return c.json({ error: `Unknown network: ${body.networkSlug}` }, 400);
  }

  const [rpcConfig] = await db
    .insert(chainOrgRpcConfigs)
    .values({
      orgId,
      networkId: network.id,
      rpcUrl: body.rpcUrl,
      isActive: body.isActive,
    })
    .onConflictDoUpdate({
      target: [chainOrgRpcConfigs.orgId, chainOrgRpcConfigs.networkId],
      set: {
        rpcUrl: body.rpcUrl,
        isActive: body.isActive,
      },
    })
    .returning();

  return c.json({ data: rpcConfig }, 201);
});

// ---------------------------------------------------------------------------
// GET /modules/chain/rpc-usage -- RPC usage metrics
// ---------------------------------------------------------------------------

chainRouter.get('/rpc-usage', async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const from = c.req.query('from');
  const to = c.req.query('to');
  const networkSlug = c.req.query('networkSlug');

  const conditions = [eq(chainRpcUsageHourly.orgId, orgId)];
  if (from) conditions.push(gte(chainRpcUsageHourly.bucket, new Date(from)));
  if (to) conditions.push(lte(chainRpcUsageHourly.bucket, new Date(to)));
  if (networkSlug) conditions.push(eq(chainRpcUsageHourly.networkSlug, networkSlug));

  const rows = await db
    .select()
    .from(chainRpcUsageHourly)
    .where(and(...conditions))
    .orderBy(desc(chainRpcUsageHourly.bucket))
    .limit(1000);

  const totalCalls = rows.reduce((sum, r) => sum + r.callCount, 0);
  const errorCalls = rows.filter(r => r.status === 'error').reduce((sum, r) => sum + r.callCount, 0);

  return c.json({
    data: rows,
    summary: {
      totalCalls,
      errorRate: totalCalls > 0 ? errorCalls / totalCalls : 0,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/chain/state-changes -- state change history
// ---------------------------------------------------------------------------

const stateChangesQuerySchema = z.object({
  ruleId: z.string().uuid().optional(),
  address: z.string().optional(),
  snapshotType: z.enum(['balance', 'storage', 'view-call']).optional(),
  triggeredOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

chainRouter.get('/state-changes', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const query = stateChangesQuerySchema.parse(c.req.query());
  const db = getDb();

  // Build conditions
  const conditions = [];

  if (query.ruleId) {
    conditions.push(eq(chainStateSnapshots.ruleId, query.ruleId));
  }
  if (query.address) {
    conditions.push(eq(chainStateSnapshots.address, query.address.toLowerCase()));
  }
  if (query.snapshotType) {
    conditions.push(eq(chainStateSnapshots.snapshotType, query.snapshotType));
  }
  if (query.triggeredOnly) {
    conditions.push(eq(chainStateSnapshots.triggered, true));
  }

  const whereClause =
    conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: chainStateSnapshots.id,
      ruleId: chainStateSnapshots.ruleId,
      detectionId: chainStateSnapshots.detectionId,
      networkId: chainStateSnapshots.networkId,
      address: chainStateSnapshots.address,
      snapshotType: chainStateSnapshots.snapshotType,
      slot: chainStateSnapshots.slot,
      value: chainStateSnapshots.value,
      blockNumber: chainStateSnapshots.blockNumber,
      polledAt: chainStateSnapshots.polledAt,
      triggered: chainStateSnapshots.triggered,
      triggerContext: chainStateSnapshots.triggerContext,
    })
    .from(chainStateSnapshots)
    .where(whereClause)
    .orderBy(desc(chainStateSnapshots.polledAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({
    data: rows,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      count: rows.length,
    },
  });
});
