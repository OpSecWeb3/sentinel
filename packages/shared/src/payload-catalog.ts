/**
 * Payload field catalog — extracts JSON key paths from event payloads
 * and alert triggerData, upserts to the catalog table.
 *
 * Uses a Redis Set as a bloom filter: if we've already cataloged a
 * (source, sourceType) combo, skip entirely. The Set key has a 24h TTL
 * so schemas are re-checked daily (when payloads might evolve).
 */
import type { Redis } from 'ioredis';

const REDIS_KEY_PREFIX = 'payload-catalog:seen:';
const TTL_SECONDS = 86400; // 24h
const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// JSON key path extraction
// ---------------------------------------------------------------------------

interface FieldEntry {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
}

function inferType(value: unknown): FieldEntry['type'] {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  return 'string';
}

export function extractFieldPaths(
  obj: Record<string, unknown>,
  prefix = '',
  depth = 0,
): FieldEntry[] {
  if (depth >= MAX_DEPTH) return [];
  const entries: FieldEntry[] = [];

  for (const [key, value] of Object.entries(obj)) {
    // Skip internal/meta keys
    if (key.startsWith('_')) continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const type = inferType(value);

    entries.push({ path, type });

    // Recurse into objects (but not arrays — array element paths are too variable)
    if (type === 'object' && value !== null) {
      entries.push(...extractFieldPaths(value as Record<string, unknown>, path, depth + 1));
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Catalog service
// ---------------------------------------------------------------------------

export interface CatalogDeps {
  redis: Redis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { execute: (query: any) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any;
}

/**
 * Catalog payload fields for an event.
 * Returns true if cataloging was performed, false if skipped (already seen).
 */
export async function catalogEventFields(
  deps: CatalogDeps,
  moduleId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const cacheKey = `${REDIS_KEY_PREFIX}events:${moduleId}:${eventType}`;

  // Check if already cataloged within TTL
  const seen = await deps.redis.exists(cacheKey);
  if (seen) return false;

  const fields = extractFieldPaths(payload);
  if (fields.length === 0) return false;

  // Upsert all field paths
  await upsertFields(deps, 'events', moduleId, fields);

  // Mark as seen with TTL
  await deps.redis.set(cacheKey, '1', 'EX', TTL_SECONDS);

  return true;
}

/**
 * Catalog triggerData fields for an alert.
 */
export async function catalogAlertFields(
  deps: CatalogDeps,
  triggerType: string,
  triggerData: Record<string, unknown>,
): Promise<boolean> {
  const cacheKey = `${REDIS_KEY_PREFIX}alerts:${triggerType}`;

  const seen = await deps.redis.exists(cacheKey);
  if (seen) return false;

  const fields = extractFieldPaths(triggerData);
  if (fields.length === 0) return false;

  await upsertFields(deps, 'alerts', triggerType, fields);
  await deps.redis.set(cacheKey, '1', 'EX', TTL_SECONDS);

  return true;
}

async function upsertFields(
  deps: CatalogDeps,
  source: string,
  sourceType: string,
  fields: FieldEntry[],
): Promise<void> {
  // Build a single multi-row INSERT ... ON CONFLICT UPDATE last_seen_at
  const { sql } = deps;
  const values = fields.map(
    (f) => sql`(${source}, ${sourceType}, ${f.path}, ${f.type}, NOW(), NOW())`,
  );

  await deps.db.execute(sql`
    INSERT INTO payload_field_catalog (source, source_type, field_path, field_type, first_seen_at, last_seen_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (source, source_type, field_path)
    DO UPDATE SET
      last_seen_at = NOW(),
      field_type = EXCLUDED.field_type
  `);
}
