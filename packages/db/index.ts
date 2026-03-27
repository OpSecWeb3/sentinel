import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as coreSchema from './schema/core';
import * as githubSchema from './schema/github';
import * as releaseChainSchema from './schema/release-chain';
import * as infraSchema from './schema/infra';
import * as chainSchema from './schema/chain';
import * as correlationSchema from './schema/correlation';

// ---------------------------------------------------------------------------
// Re-export drizzle-orm query helpers.
// Every package in the monorepo imports these from @sentinel/db instead of
// depending on drizzle-orm directly. This keeps drizzle-orm as a single
// dependency owned by this package.
// ---------------------------------------------------------------------------

export {
  eq, ne, gt, gte, lt, lte,
  and, or, not,
  asc, desc,
  sql,
  count,
  inArray, notInArray,
  isNull, isNotNull,
  ilike, like,
  between,
  exists,
  type InferSelectModel,
  type InferInsertModel,
} from 'drizzle-orm';

// Re-export drizzle constructor and migrator for test helpers
export { drizzle } from 'drizzle-orm/postgres-js';
export { migrate } from 'drizzle-orm/postgres-js/migrator';

// ---------------------------------------------------------------------------
// Schema + DB client
// ---------------------------------------------------------------------------

export const schema = {
  ...coreSchema,
  ...githubSchema,
  ...releaseChainSchema,
  ...infraSchema,
  ...chainSchema,
  ...correlationSchema,
};

let _sql: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

export function getDb(databaseUrl?: string) {
  if (!_db) {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    _sql = postgres(url);
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end();
    _sql = undefined;
    _db = undefined;
  }
}

export { coreSchema, githubSchema, releaseChainSchema, infraSchema, chainSchema, correlationSchema };
export type Db = ReturnType<typeof getDb>;
