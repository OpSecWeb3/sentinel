# Debug: "At least one RPC URL is required"

Job `chain.state.poll` failing because `rule.rpcUrls` is empty.

## 0. Find the right containers

```bash
docker ps --filter name=sentinel --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
```

## 1. Get the ruleId from the failed job (via redis-cli)

```bash
docker exec -it redis redis-cli -a $REDIS_PASSWORD --no-auth-warning ZREVRANGE bull:module-jobs:failed 0 9
```

Then check which ones are `chain.state.poll` (most recent 10 failed jobs):

```bash
docker exec -it redis redis-cli -a $REDIS_PASSWORD --no-auth-warning eval "
local ids = redis.call('ZREVRANGE', 'bull:module-jobs:failed', 0, 49)
local results = {}
for _, id in ipairs(ids) do
  local name = redis.call('HGET', 'bull:module-jobs:' .. id, 'name')
  if name == 'chain.state.poll' then
    local data = redis.call('HGET', 'bull:module-jobs:' .. id, 'data')
    table.insert(results, id .. ' | ' .. data)
  end
end
return results
" 0
```

## 2. Get the rule config and network slug

The `rules` table stores chain config in a `config` jsonb column. The network/RPC info comes from `chain_networks` via `config->>'networkSlug'`.

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT r.id, r.rule_type, r.config->>'networkSlug' AS network_slug, r.config->>'address' AS address, d.name AS detection_name FROM rules r JOIN detections d ON d.id = r.detection_id WHERE r.id = '6accefa1-eaf3-416d-8b2a-e2be37109423';"
```

## 3. Check the network's RPC URL

Use the `network_slug` from step 2:

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT id, name, slug, chain_id, rpc_url, is_active FROM chain_networks WHERE slug = 'PASTE_NETWORK_SLUG_HERE';"
```

## 4. Check if the org has a custom RPC override

Use the `org_id` from step 2's rule row:

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT c.rpc_url, c.is_active, n.slug FROM chain_org_rpc_configs c JOIN chain_networks n ON n.id = c.network_id WHERE c.org_id = 'PASTE_ORG_ID_HERE';"
```

> If the postgres container name or user differs, check with:
> `docker ps --filter name=postgres --format "{{.Names}}"`

---

## Fix: Patch missing networkSlug and deactivate non-ethereum networks

### 5. Set networkSlug on the failing rule

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "UPDATE rules SET config = config || '{\"networkSlug\": \"ethereum\"}' WHERE id = '6accefa1-eaf3-416d-8b2a-e2be37109423';"
```

### 6. Fix ALL chain rules missing a networkSlug

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "UPDATE rules SET config = config || '{\"networkSlug\": \"ethereum\"}' WHERE module_id = 'chain' AND status = 'active' AND (config->>'networkSlug' IS NULL OR config->>'networkSlug' = '');"
```

### 7. Deactivate non-ethereum networks

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "UPDATE chain_networks SET is_active = false WHERE slug != 'ethereum';"
```

### 8. Verify the fix

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT r.id, r.config->>'networkSlug' AS network_slug, r.config->>'address' AS address FROM rules r WHERE r.module_id = 'chain' AND r.status = 'active';"
```

### 9. Inspect chain rules with no address

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT r.id, r.rule_type, d.name AS detection_name FROM rules r JOIN detections d ON d.id = r.detection_id WHERE r.module_id = 'chain' AND r.status = 'active' AND (r.config->>'address' IS NULL OR r.config->>'address' = '');"
```

### 10. Check full config for blank-address rules

Addresses may be under a different key. Inspect the full config before disabling:

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT r.id, r.rule_type, d.name, r.config FROM rules r JOIN detections d ON d.id = r.detection_id WHERE r.module_id = 'chain' AND r.status = 'active' AND (r.config->>'address' IS NULL OR r.config->>'address' = '') LIMIT 3;"
```

### 11. Hotfix: copy contractAddress into address (immediate prod fix)

The handler reads `config.address` but templates wrote `config.contractAddress`. Code fix is in `handlers.ts:1111` but until deployed, patch the data:

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "UPDATE rules SET config = config || jsonb_build_object('address', config->>'contractAddress') WHERE module_id = 'chain' AND status = 'active' AND (config->>'address' IS NULL OR config->>'address' = '') AND config->>'contractAddress' IS NOT NULL;"
```

### 12. Verify all chain rules now have an address

```bash
docker exec -it chainalert-postgres-1 psql -U sentinel -d sentinel -c \
  "SELECT r.id, r.rule_type, r.config->>'address' AS address, r.config->>'contractAddress' AS contract_address FROM rules r WHERE r.module_id = 'chain' AND r.status = 'active';"
```
