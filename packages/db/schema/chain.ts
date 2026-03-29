import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  serial, integer, bigint, bigserial, real,
  uniqueIndex, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users, detections, rules } from './core';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Networks (blockchain metadata)
// ---------------------------------------------------------------------------

export const chainNetworks = pgTable('chain_networks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  chainKey: text('chain_key').unique().notNull(),
  chainId: integer('chain_id').notNull(),
  rpcUrl: text('rpc_url').notNull(),
  blockTimeMs: integer('block_time_ms').notNull(),
  explorerUrl: text('explorer_url'),
  explorerApi: text('explorer_api'),
  isActive: boolean('is_active').notNull().default(true),
});

// ---------------------------------------------------------------------------
// Contracts (global contract registry)
// ---------------------------------------------------------------------------

export const chainContracts = pgTable('chain_contracts', {
  id: serial('id').primaryKey(),
  networkId: integer('network_id').notNull().references(() => chainNetworks.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),
  name: text('name'),
  abi: jsonb('abi').notNull(),
  isProxy: boolean('is_proxy').notNull().default(false),
  implementation: text('implementation'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  storageLayout: jsonb('storage_layout'),
  layoutStatus: text('layout_status'),
  traits: jsonb('traits').notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  uniqueIndex('uq_chain_contracts_network_address').on(t.networkId, t.address),
]);

// ---------------------------------------------------------------------------
// Org contracts (org-scoped contract registry with labels, tags, notes)
// ---------------------------------------------------------------------------

export const chainOrgContracts = pgTable('chain_org_contracts', {
  id: serial('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  contractId: integer('contract_id').notNull().references(() => chainContracts.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  notes: text('notes'),
  addedBy: uuid('added_by').notNull().references(() => users.id),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_chain_org_contracts_org_contract').on(t.orgId, t.contractId),
  index('idx_chain_org_contracts_org').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// Org RPC configs (custom RPC endpoints per org per network)
// ---------------------------------------------------------------------------

export const chainOrgRpcConfigs = pgTable('chain_org_rpc_configs', {
  id: serial('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  networkId: integer('network_id').notNull().references(() => chainNetworks.id, { onDelete: 'cascade' }),
  rpcUrl: text('rpc_url').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_chain_org_rpc_configs_org_network').on(t.orgId, t.networkId),
  index('idx_chain_org_rpc_configs_org').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// Detection templates (blockchain-specific)
// ---------------------------------------------------------------------------

export const chainDetectionTemplates = pgTable('chain_detection_templates', {
  id: serial('id').primaryKey(),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  icon: text('icon'),
  severityDefault: text('severity_default').notNull().default('high'),
  tier: text('tier').notNull().default('mvp'),
  inputs: jsonb('inputs').notNull(),
  ruleTemplates: jsonb('rule_templates').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt,
});

// ---------------------------------------------------------------------------
// Block cursors (per-network polling position)
// ---------------------------------------------------------------------------

export const chainBlockCursors = pgTable('chain_block_cursors', {
  networkId: integer('network_id').primaryKey().references(() => chainNetworks.id, { onDelete: 'cascade' }),
  lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
  updatedAt,
});

// ---------------------------------------------------------------------------
// State snapshots (balance / storage / view-call tracking)
// ---------------------------------------------------------------------------

export const chainStateSnapshots = pgTable('chain_state_snapshots', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  ruleId: uuid('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  detectionId: uuid('detection_id').references(() => detections.id, { onDelete: 'set null' }),
  networkId: integer('network_id').notNull().references(() => chainNetworks.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),
  snapshotType: text('snapshot_type').notNull(),
  slot: text('slot'),
  value: text('value').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }),
  polledAt: timestamp('polled_at', { withTimezone: true }).notNull(),
  triggered: boolean('triggered').notNull().default(false),
  triggerContext: jsonb('trigger_context'),
}, (t) => [
  // Composite index: all window/previous-value queries ORDER BY polled_at DESC
  index('idx_chain_snapshots_rule_time').on(t.ruleId, t.polledAt),
  index('idx_chain_snapshots_address_slot').on(t.address, t.slot).where(sql`slot IS NOT NULL`),
  index('idx_chain_snapshots_triggered').on(t.detectionId, t.polledAt).where(sql`triggered = true`),
]);

// ---------------------------------------------------------------------------
// RPC usage tracking (hourly bucketed)
// ---------------------------------------------------------------------------

export const chainRpcUsageHourly = pgTable('chain_rpc_usage_hourly', {
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  orgId: text('org_id').notNull().default('_system'),
  networkSlug: text('network_slug').notNull(),
  templateSlug: text('template_slug').notNull().default('_unknown'),
  detectionId: text('detection_id').notNull().default('_system'),
  rpcMethod: text('rpc_method').notNull(),
  status: text('status').notNull().default('ok'),
  callCount: integer('call_count').notNull().default(0),
}, (t) => [
  primaryKey({
    columns: [
      t.bucket,
      t.orgId,
      t.networkSlug,
      t.templateSlug,
      t.detectionId,
      t.rpcMethod,
      t.status,
    ],
  }),
  index('idx_chain_rpc_usage_org_bucket').on(t.orgId, t.bucket),
  index('idx_chain_rpc_usage_bucket').on(t.bucket),
]);

// ---------------------------------------------------------------------------
// Container metrics
// ---------------------------------------------------------------------------

export const chainContainerMetrics = pgTable('chain_container_metrics', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  containerName: text('container_name').notNull(),
  cpuPercent: real('cpu_percent').notNull(),
  memoryUsageMb: real('memory_usage_mb').notNull(),
  memoryLimitMb: real('memory_limit_mb').notNull(),
  memoryPercent: real('memory_percent').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_chain_container_metrics_name_time').on(t.containerName, t.recordedAt),
  index('idx_chain_container_metrics_time').on(t.recordedAt),
]);
