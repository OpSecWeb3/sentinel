/**
 * Chain module Hono router.
 *
 * Provides REST endpoints for managing blockchain networks, contracts,
 * RPC configurations, and querying state change history. Follows the
 * same router pattern as the GitHub and registry modules.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gte, lte, count, sql, ne, ilike, or, inArray } from '@sentinel/db';
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
import { detections, rules, alerts, events } from '@sentinel/db/schema/core';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { templates as chainTemplates } from './templates/index.js';

export const chainRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helper: build ABI function/event signature string
// ---------------------------------------------------------------------------

function buildSignature(item: any): string {
  const inputs = (item.inputs ?? []).map((i: any) => i.type).join(',');
  return `${item.name}(${inputs})`;
}

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
      inputs: t.inputs ?? [],
    }));
  return c.json({ data, meta: { total: data.length } });
});

// ---------------------------------------------------------------------------
// GET /modules/chain/networks -- list supported networks
// Fix 1: return frontend-expected field mapping
// ---------------------------------------------------------------------------

chainRouter.get('/networks', async (c) => {
  const db = getDb();

  const rows = await db
    .select({
      id: chainNetworks.id,
      name: chainNetworks.name,
      slug: chainNetworks.slug,
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
    const currentBlock = cursor?.lastBlock ? Number(cursor.lastBlock) : null;
    return {
      id: n.id,
      name: n.name,
      slug: n.slug,
      chainId: n.chainId,
      blockTime: Math.round(n.blockTimeMs / 1000),
      explorerUrl: n.explorerUrl ?? null,
      pollingActive: n.isActive,
      currentBlock,
      cursorPosition: currentBlock,
      rpcHealthy: true,
      lastPolledAt: cursor?.updatedAt?.toISOString() ?? null,
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
// Fix 2: fix response + add pagination + search
// ---------------------------------------------------------------------------

chainRouter.get('/contracts', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const rawQuery = c.req.query();
  const contractsQuerySchema = z.object({
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const query = contractsQuerySchema.parse(rawQuery);

  const db = getDb();

  // Build base conditions
  const baseConditions = [eq(chainOrgContracts.orgId, orgId)];
  if (query.search) {
    const escapedSearch = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    baseConditions.push(
      or(
        ilike(chainOrgContracts.label, `%${escapedSearch}%`),
        ilike(chainContracts.address, `%${escapedSearch}%`),
      ) as any,
    );
  }

  const whereClause = and(...baseConditions);

  // Total count
  const [countRow] = await db
    .select({ total: count() })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(whereClause);

  const total = Number(countRow?.total ?? 0);

  const rows = await db
    .select({
      id: chainOrgContracts.id,
      contractId: chainContracts.id,
      label: chainOrgContracts.label,
      tags: chainOrgContracts.tags,
      notes: chainOrgContracts.notes,
      createdAt: chainOrgContracts.createdAt,
      // Contract details
      address: chainContracts.address,
      networkId: chainContracts.networkId,
      abi: chainContracts.abi,
      fetchedAt: chainContracts.fetchedAt,
      layoutStatus: chainContracts.layoutStatus,
      // Network details
      networkName: chainNetworks.name,
      explorerUrl: chainNetworks.explorerUrl,
      detectionCount: sql<number>`(
        SELECT COUNT(DISTINCT r.detection_id)::int
        FROM rules r
        INNER JOIN chain_networks cn ON cn.chain_id = (r.config->>'networkId')::int
        WHERE r.module_id = 'chain'
          AND r.status != 'disabled'
          AND lower(r.config->>'contractAddress') = lower(${chainContracts.address})
          AND cn.id = ${chainContracts.networkId}
      )`.as('detection_count'),
    })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(whereClause)
    .orderBy(desc(chainOrgContracts.createdAt))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const data = rows.map((row) => {
    const abiArray = Array.isArray(row.abi) ? row.abi as any[] : [];
    const abiStatus: 'loaded' | 'pending' | 'missing' | 'error' =
      abiArray.length > 0 ? 'loaded' : (row.fetchedAt ? 'missing' : 'pending');
    const eventCount = abiArray.filter((x: any) => x.type === 'event').length;
    const functionCount = abiArray.filter((x: any) => x.type === 'function').length;

    return {
      id: row.id,
      contractId: row.contractId,
      label: row.label,
      address: row.address,
      networkId: row.networkId,
      networkName: row.networkName,
      explorerUrl: row.explorerUrl ?? null,
      abiStatus,
      tags: row.tags ?? [],
      notes: row.notes ?? null,
      eventCount,
      functionCount,
      detectionCount: row.detectionCount,
      createdAt: row.createdAt?.toISOString() ?? null,
    };
  });

  return c.json({
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/contracts -- add contract
// Fix 3: accept networkId instead of networkSlug
// ---------------------------------------------------------------------------

const addContractSchema = z.object({
  networkId: z.coerce.number().int().positive(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  label: z.string().min(1),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  abi: z.unknown().optional(),
  fetchAbi: z.boolean().default(false),
});

chainRouter.post('/contracts', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (!userId) return c.json({ error: 'User context required' }, 403);

  const body = addContractSchema.parse(await c.req.json());
  const db = getDb();

  // Resolve network by ID
  const [network] = await db
    .select()
    .from(chainNetworks)
    .where(eq(chainNetworks.id, body.networkId))
    .limit(1);

  if (!network) {
    return c.json({ error: `Unknown network: ${body.networkId}` }, 400);
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

  // If fetchAbi is true or no ABI was provided, schedule a verification job
  const hasAbi = body.abi && Array.isArray(body.abi) && (body.abi as any[]).length > 0;
  if (body.fetchAbi || !hasAbi) {
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await queue.add('chain.contract.verify', {
      contractId: contract.id,
      networkSlug: network.slug,
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
        networkId: network.id,
        networkSlug: network.slug,
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

  const contractId = parseInt(c.req.param('id'), 10);
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

  // Parse ABI into events + functions
  const abi = Array.isArray(row.abi) ? row.abi as any[] : [];
  const abiEvents = abi
    .filter((x: any) => x.type === 'event')
    .map((x: any) => ({ name: x.name, signature: buildSignature(x) }));
  const abiFunctions = abi
    .filter((x: any) => x.type === 'function')
    .map((x: any) => ({ name: x.name, signature: buildSignature(x), stateMutability: x.stateMutability ?? null }));

  // Find linked detections (rules that reference this contract address)
  const linkedDetectionsRaw = await db
    .select({
      id: detections.id,
      name: detections.name,
      severity: detections.severity,
      status: detections.status,
    })
    .from(rules)
    .innerJoin(detections, eq(detections.id, rules.detectionId))
    .where(
      and(
        eq(rules.orgId, orgId),
        eq(rules.moduleId, 'chain'),
        eq(rules.status, 'active'),
        ne(detections.status, 'disabled'),
        sql`lower(rules.config->>'contractAddress') = lower(${row.address})`,
      ),
    );
  // Deduplicate by detection ID (multiple rules may link same detection)
  const seenIds = new Set<string>();
  const linkedDetections = linkedDetectionsRaw.filter((d) => {
    if (seenIds.has(d.id)) return false;
    seenIds.add(d.id);
    return true;
  });

  return c.json({
    data: {
      ...row,
      abiEvents,
      abiFunctions,
      linkedDetections,
    },
  });
});

// ---------------------------------------------------------------------------
// Fix 4: GET /modules/chain/contracts/:id/detail -- parsed ABI detail
// ---------------------------------------------------------------------------

chainRouter.get('/contracts/:id/detail', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const contractId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(contractId)) {
    return c.json({ error: 'Invalid contract ID' }, 400);
  }

  const db = getDb();

  const [row] = await db
    .select({
      abi: chainContracts.abi,
    })
    .from(chainOrgContracts)
    .innerJoin(chainContracts, eq(chainContracts.id, chainOrgContracts.contractId))
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

  const abi = Array.isArray(row.abi) ? row.abi as any[] : [];
  const eventsAbi = abi.filter((x: any) => x.type === 'event');
  const functionsAbi = abi.filter((x: any) => x.type === 'function');

  return c.json({
    data: {
      abi,
      events: eventsAbi.map((x: any) => ({
        name: x.name,
        signature: buildSignature(x),
      })),
      functions: functionsAbi.map((x: any) => ({
        name: x.name,
        signature: buildSignature(x),
        stateMutability: x.stateMutability ?? null,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /modules/chain/contracts/:id/verify -- fetch/verify ABI from explorer
// ---------------------------------------------------------------------------

chainRouter.post('/contracts/:id/verify', async (c) => {
  const orgId = c.get('orgId');
  const contractId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(contractId)) return c.json({ error: 'Invalid contract ID' }, 400);

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
// Fix 5: POST /modules/chain/contracts/:id/fetch-abi -- alias for verify
// ---------------------------------------------------------------------------

chainRouter.post('/contracts/:id/fetch-abi', async (c) => {
  const orgId = c.get('orgId');
  const contractId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(contractId)) return c.json({ error: 'Invalid contract ID' }, 400);

  const db = getDb();

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
// Fix 6: PATCH /modules/chain/contracts/:id -- update label, tags, notes
// ---------------------------------------------------------------------------

const patchContractSchema = z.object({
  label: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});

chainRouter.patch('/contracts/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const contractId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(contractId)) return c.json({ error: 'Invalid contract ID' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = patchContractSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();

  // Verify org owns this contract
  const [existing] = await db
    .select({ id: chainOrgContracts.id })
    .from(chainOrgContracts)
    .where(and(eq(chainOrgContracts.contractId, contractId), eq(chainOrgContracts.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: 'Contract not found' }, 404);

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.label !== undefined) updateData.label = parsed.data.label;
  if (parsed.data.tags !== undefined) updateData.tags = parsed.data.tags;
  if (parsed.data.notes !== undefined) updateData.notes = parsed.data.notes;

  const [updated] = await db
    .update(chainOrgContracts)
    .set(updateData)
    .where(and(eq(chainOrgContracts.contractId, contractId), eq(chainOrgContracts.orgId, orgId)))
    .returning();

  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// GET /modules/chain/rpc-configs -- org RPC configs
// Fix 7: fix response field mapping
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
      // Network details
      networkName: chainNetworks.name,
    })
    .from(chainOrgRpcConfigs)
    .innerJoin(chainNetworks, eq(chainNetworks.id, chainOrgRpcConfigs.networkId))
    .where(eq(chainOrgRpcConfigs.orgId, orgId));

  const data = rows.map((r) => ({
    id: r.id,
    networkId: r.networkId,
    networkName: r.networkName,
    customUrl: r.rpcUrl,
    status: r.isActive ? 'active' : 'inactive',
    callCount: 0,
    errorCount: 0,
    avgLatencyMs: null,
    lastCheckedAt: null,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));

  return c.json({ data, meta: { total: data.length } });
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

// ---------------------------------------------------------------------------
// Fix 8: GET /modules/chain/events -- paginated on-chain events
// ---------------------------------------------------------------------------

const eventsQuerySchema = z.object({
  eventName: z.string().optional(),
  contractAddress: z.string().optional(),
  networkSlug: z.string().optional(),
  page: z.coerce.number().int().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

chainRouter.get('/events', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const query = eventsQuerySchema.parse(c.req.query());
  const db = getDb();

  const baseConditions = [
    eq(events.orgId, orgId),
    eq(events.moduleId, 'chain'),
  ];

  if (query.eventName) {
    baseConditions.push(eq(events.eventType, query.eventName));
  }
  if (query.contractAddress) {
    baseConditions.push(
      sql`LOWER(${events.payload}->>'address') = ${query.contractAddress.toLowerCase()}`,
    );
  }
  if (query.networkSlug) {
    baseConditions.push(
      sql`${events.payload}->>'networkSlug' = ${query.networkSlug}`,
    );
  }

  const whereClause = and(...baseConditions);

  // Total count
  const [countRow] = await db
    .select({ total: count() })
    .from(events)
    .where(whereClause);

  const total = Number(countRow?.total ?? 0);

  const rows = await db
    .select({
      id: events.id,
      eventName: events.eventType,
      payload: events.payload,
      createdAt: events.receivedAt,
      // Contract label via LEFT JOINs
      contractLabel: chainOrgContracts.label,
      explorerUrl: chainNetworks.explorerUrl,
    })
    .from(events)
    .leftJoin(
      chainContracts,
      sql`LOWER(${events.payload}->>'address') = ${chainContracts.address}`,
    )
    .leftJoin(
      chainOrgContracts,
      and(
        eq(chainOrgContracts.contractId, chainContracts.id),
        eq(chainOrgContracts.orgId, orgId),
      ),
    )
    .leftJoin(chainNetworks, eq(chainNetworks.id, chainContracts.networkId))
    .where(whereClause)
    .orderBy(desc(events.receivedAt))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const data = rows.map((row) => {
    const p = (row.payload ?? {}) as Record<string, any>;
    return {
      id: row.id,
      eventName: row.eventName,
      contractAddress: p.address ?? null,
      contractLabel: row.contractLabel ?? null,
      networkName: p.network ?? null,
      networkSlug: p.networkSlug ?? null,
      explorerUrl: row.explorerUrl ?? null,
      blockNumber: p.blockNumber != null ? Number(p.blockNumber) : null,
      txHash: p.transactionHash ?? null,
      logIndex: p.logIndex != null ? Number(p.logIndex) : null,
      decodedArgs: p.decodedArgs ?? null,
      rawTopics: p.rawTopics ?? [],
      rawData: p.rawData ?? null,
      createdAt: row.createdAt?.toISOString() ?? null,
    };
  });

  return c.json({
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});

// ---------------------------------------------------------------------------
// Fix 9: Detection CRUD
// ---------------------------------------------------------------------------

// POST /modules/chain/detections

const createDetectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  cooldownMinutes: z.coerce.number().int().min(0).default(0),
  channelIds: z.array(z.string().uuid()).default([]),
  rules: z.array(z.object({
    ruleType: z.string().min(1),
    config: z.record(z.unknown()),
    action: z.string().default('alert'),
    priority: z.coerce.number().int().default(50),
  })).min(1),
});

chainRouter.post('/detections', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (!userId) return c.json({ error: 'User context required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = createDetectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();

  // Insert detection
  const detectionValues: any = {
    orgId,
    createdBy: userId,
    moduleId: 'chain',
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    severity: parsed.data.severity,
    status: 'active',
    channelIds: parsed.data.channelIds,
    cooldownMinutes: parsed.data.cooldownMinutes,
  };
  const [detection] = await db
    .insert(detections)
    .values(detectionValues)
    .returning();

  // Insert rules
  const createdRules = [];
  for (const ruleInput of parsed.data.rules) {
    const ruleValues: any = {
      detectionId: detection.id,
      orgId,
      moduleId: 'chain',
      ruleType: ruleInput.ruleType,
      config: ruleInput.config,
      action: ruleInput.action,
      priority: ruleInput.priority,
      status: 'active',
    };
    const [rule] = await db
      .insert(rules)
      .values(ruleValues)
      .returning();

    createdRules.push(rule);

    // Enqueue rule sync
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await queue.add('chain.rule.sync', {
      action: 'add',
      ruleId: rule.id,
      config: { ruleType: rule.ruleType, ...rule.config as object },
    });
  }

  return c.json(
    {
      data: {
        id: detection.id,
        name: detection.name,
        status: detection.status,
        rules: createdRules,
      },
    },
    201,
  );
});

// GET /modules/chain/detections

const listDetectionsQuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

chainRouter.get('/detections', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const query = listDetectionsQuerySchema.parse(c.req.query());
  const db = getDb();

  const baseConditions = [
    eq(detections.orgId, orgId),
    eq(detections.moduleId, 'chain'),
  ];
  if (query.status) {
    baseConditions.push(eq(detections.status, query.status));
  }

  const whereClause = and(...baseConditions);

  const [countRow] = await db
    .select({ total: count() })
    .from(detections)
    .where(whereClause);

  const total = Number(countRow?.total ?? 0);

  const rows = await db
    .select({
      id: detections.id,
      name: detections.name,
      severity: detections.severity,
      status: detections.status,
      cooldownMinutes: detections.cooldownMinutes,
      lastTriggeredAt: detections.lastTriggeredAt,
      createdAt: detections.createdAt,
    })
    .from(detections)
    .where(whereClause)
    .orderBy(desc(detections.createdAt))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  // Get rule counts per detection
  const detectionIds = rows.map((r) => r.id);
  let ruleCountMap = new Map<string, number>();
  if (detectionIds.length > 0) {
    const ruleCounts = await db
      .select({ detectionId: rules.detectionId, total: count() })
      .from(rules)
      .where(and(
        inArray(rules.detectionId, detectionIds),
        eq(rules.moduleId, 'chain'),
        ne(rules.status, 'disabled'),
      ))
      .groupBy(rules.detectionId);
    ruleCountMap = new Map(ruleCounts.map((r) => [r.detectionId, Number(r.total)]));
  }

  const data = rows.map((row) => ({
    id: row.id,
    name: row.name,
    severity: row.severity,
    status: row.status,
    cooldownMinutes: row.cooldownMinutes,
    ruleCount: ruleCountMap.get(row.id) ?? 0,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? null,
  }));

  return c.json({
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});

// GET /modules/chain/detections/:id

chainRouter.get('/detections/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const detectionId = c.req.param('id');

  const db = getDb();

  const [detection] = await db
    .select()
    .from(detections)
    .where(
      and(
        eq(detections.id, detectionId),
        eq(detections.orgId, orgId),
        eq(detections.moduleId, 'chain'),
      ),
    )
    .limit(1);

  if (!detection) return c.json({ error: 'Detection not found' }, 404);

  const detectionRules = await db
    .select()
    .from(rules)
    .where(eq(rules.detectionId, detectionId))
    .orderBy(rules.priority);

  return c.json({ data: { ...detection, rules: detectionRules } });
});

// PATCH /modules/chain/detections/:id

const patchDetectionSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  cooldownMinutes: z.coerce.number().int().min(0).optional(),
  channelIds: z.array(z.string().uuid()).optional(),
});

chainRouter.patch('/detections/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Admin or editor role required' }, 403);

  const detectionId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = patchDetectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();

  // Verify org owns detection
  const [existing] = await db
    .select({ id: detections.id, status: detections.status })
    .from(detections)
    .where(and(eq(detections.id, detectionId), eq(detections.orgId, orgId), eq(detections.moduleId, 'chain')))
    .limit(1);

  if (!existing) return c.json({ error: 'Detection not found' }, 404);

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.severity !== undefined) updateData.severity = parsed.data.severity;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.cooldownMinutes !== undefined) updateData.cooldownMinutes = parsed.data.cooldownMinutes;
  if (parsed.data.channelIds !== undefined) updateData.channelIds = parsed.data.channelIds;

  const [updated] = await db
    .update(detections)
    .set(updateData)
    .where(and(eq(detections.id, detectionId), eq(detections.orgId, orgId)))
    .returning();

  // If status changes to disabled, enqueue chain.rule.sync remove for each rule
  if (parsed.data.status === 'disabled' && existing.status !== 'disabled') {
    const detectionRules = await db
      .select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
      .from(rules)
      .where(eq(rules.detectionId, detectionId));

    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    for (const rule of detectionRules) {
      await queue.add('chain.rule.sync', {
        action: 'remove',
        ruleId: rule.id,
        config: { ruleType: rule.ruleType, ...rule.config as object },
      });
    }
  }

  return c.json({ data: updated });
});

// DELETE /modules/chain/detections/:id

chainRouter.delete('/detections/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const detectionId = c.req.param('id');
  const db = getDb();

  // Verify org owns detection
  const [existing] = await db
    .select({ id: detections.id })
    .from(detections)
    .where(and(eq(detections.id, detectionId), eq(detections.orgId, orgId), eq(detections.moduleId, 'chain')))
    .limit(1);

  if (!existing) return c.json({ error: 'Detection not found' }, 404);

  // Get rules before deletion for sync jobs
  const detectionRules = await db
    .select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
    .from(rules)
    .where(eq(rules.detectionId, detectionId));

  // Enqueue remove sync for each rule
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  for (const rule of detectionRules) {
    await queue.add('chain.rule.sync', {
      action: 'remove',
      ruleId: rule.id,
      config: { ruleType: rule.ruleType, ...rule.config as object },
    });
  }

  // Delete detection (cascade handles rules)
  await db
    .delete(detections)
    .where(and(eq(detections.id, detectionId), eq(detections.orgId, orgId)));

  return c.body(null, 204);
});
