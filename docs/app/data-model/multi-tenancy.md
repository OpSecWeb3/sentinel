# Multi-Tenancy

Sentinel is a multi-tenant platform. Every customer is an **organization**
(`organizations` table). All data that belongs to a customer carries that
customer's `org_id` and is never readable or writable across organizational
boundaries.

## Isolation Model

The isolation strategy is **shared database, shared schema** with a
discriminator column. There is no per-tenant database, schema, or table
prefix. Instead, every row in every data table carries a `org_id uuid NOT NULL`
column, and every query that accesses data must include a `WHERE org_id = $1`
clause (or its Drizzle ORM equivalent).

This approach keeps the operational surface area small — one connection pool,
one migration path, one backup — while the application layer bears full
responsibility for ensuring queries are always scoped.

## Organization and Membership Model

Three tables implement the identity and access model:

```
users ──< org_memberships >── organizations
```

- `users` — global; a single user account can belong to multiple organizations.
- `organizations` — the tenant. Every data object links here.
- `org_memberships` — the join table. Its composite primary key `(org_id, user_id)` enforces exactly one membership record per user per org. The `role` column (`owner`, `admin`, `viewer`) determines what the member is permitted to do within that org.

To determine which organizations a user has access to, query `org_memberships`
by `user_id`:

```sql
SELECT o.*
FROM organizations o
JOIN org_memberships m ON m.org_id = o.id
WHERE m.user_id = $1;
```

To check whether a specific user is a member of a specific org:

```sql
SELECT role
FROM org_memberships
WHERE org_id = $1
  AND user_id = $2;
```

## org_id Column Convention

Every table that holds per-tenant data defines `org_id` as its first
non-PK column:

```typescript
// Typical pattern across all data tables
export const someTable = pgTable('some_table', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // … other columns
});
```

The `onDelete: 'cascade'` ensures that deleting an organization removes all of
its data automatically at the database level, with no application-level cleanup
required.

Tables that are intentionally global (not org-scoped) are the exception and
exist only in the blockchain module:

- `chain_networks` — shared network registry
- `chain_contracts` — shared contract registry
- `chain_detection_templates` — shared template library

These tables contain no customer data and are read-only from the tenant
perspective.

## API-Level Enforcement

Org context is established at the middleware layer and propagated through every
request. The general flow is:

1. **Authentication middleware** — validates the session cookie or `Authorization`
   bearer token (API key). On success, attaches `req.user` and `req.orgId` to
   the request object.

2. **Org context validation** — the user's membership in `req.orgId` is
   confirmed against `org_memberships`. Requests for an org the user does not
   belong to are rejected with `403 Forbidden` before any handler runs.

3. **Route handlers** — receive `req.orgId` as a trusted, already-validated
   value. Every database query uses this value as a filter parameter.

API key authentication follows the same pattern: the key is looked up by hash,
the associated `org_id` is loaded from `api_keys.org_id`, and that value
becomes `req.orgId` for the duration of the request.

### Drizzle Query Pattern

All service-layer queries follow this pattern. The `orgId` parameter is never
optional:

```typescript
// Correct: org_id is always part of the WHERE clause
const detections = await db
  .select()
  .from(schema.detections)
  .where(
    and(
      eq(schema.detections.orgId, orgId),
      eq(schema.detections.status, 'active'),
    )
  );
```

```typescript
// Correct: inserts always include org_id
await db.insert(schema.events).values({
  orgId,
  moduleId: 'github',
  eventType: 'pull_request.opened',
  payload: eventPayload,
  occurredAt: new Date(),
});
```

## Cross-Org Data Sharing

Cross-org data sharing is not supported by design. There is no concept of
shared workspaces, delegated access tokens, or read-only org federation.
If a user needs access to multiple organizations, they must be added as a
member of each org individually through the normal membership flow.

## Potential Pitfalls

### Missing org_id Filter (Critical Security Risk)

Omitting `org_id` from a query is a data-leakage vulnerability. It causes the
query to return or modify rows belonging to all organizations.

```typescript
// WRONG: returns detections from every org in the database
const detections = await db
  .select()
  .from(schema.detections)
  .where(eq(schema.detections.status, 'active'));

// CORRECT: scoped to the authenticated org
const detections = await db
  .select()
  .from(schema.detections)
  .where(
    and(
      eq(schema.detections.orgId, orgId),
      eq(schema.detections.status, 'active'),
    )
  );
```

There is currently no compile-time or runtime enforcement that prevents a
missing `org_id` filter. Reviewers must check every new query that touches a
data table. This is the highest-priority class of security bug in the codebase.

### Using the Wrong org_id

When handling webhook callbacks or background jobs that operate on behalf of a
specific organization, ensure the `org_id` is loaded from the database record
(e.g. `aws_integrations.org_id`, `github_installations.org_id`) and not
inferred from request context or passed in as an untrusted parameter.

```typescript
// WRONG: trusting a client-supplied org_id in a webhook payload
const orgId = req.body.orgId;

// CORRECT: load org_id from the authenticated installation record
const installation = await db
  .select()
  .from(schema.githubInstallations)
  .where(eq(schema.githubInstallations.installationId, installationId))
  .limit(1)
  .then(rows => rows[0]);

const orgId = installation.orgId;
```

### Denormalized org_id Columns

Several tables carry a denormalized `org_id` for query efficiency even though
`org_id` is already reachable via a FK join. The `rules` table is the primary
example: `rules.org_id` duplicates the value from its parent detection.
When inserting rules, always populate `org_id` from the parent detection to
prevent an inconsistency.

```typescript
// When creating a rule, inherit org_id from the detection
await db.insert(schema.rules).values({
  detectionId: detection.id,
  orgId: detection.orgId,   // always copy from the parent
  moduleId: detection.moduleId,
  // …
});
```

### Array FK columns

`detections.channel_ids` and `correlation_rules.channel_ids` hold UUID arrays
referencing `notification_channels.id`. PostgreSQL does not enforce FK
constraints on array elements. Application code must validate that all IDs in
the array belong to the same `org_id` before persisting the row.

### Soft-Deleted Channels

`notification_channels` uses a soft-delete pattern (`deleted_at IS NOT NULL`)
rather than physical deletes. Queries that list active channels must always
include:

```sql
WHERE org_id = $1
  AND deleted_at IS NULL
```

Failure to include the `deleted_at` filter exposes deleted channels in the UI
and may cause delivery attempts to stale endpoints.
