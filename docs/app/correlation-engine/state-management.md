# Correlation State Management

All in-flight correlation state lives in Redis. The database stores only the rule definitions and the `lastTriggeredAt` field used for the cooldown fallback. This design keeps the evaluation hot path fast (no DB reads during event processing beyond the cached rule load) and makes state naturally expiry-driven via Redis TTLs.

**Source**: `packages/shared/src/correlation-engine.ts`

## Redis key schema

The correlation engine uses six key prefixes:

| Prefix | Key pattern | Purpose |
|---|---|---|
| `sentinel:corr:seq` | `sentinel:corr:seq:{ruleId}:{keyHash}` | Sequence instance (JSON) |
| `sentinel:corr:idx` | `sentinel:corr:idx:{ruleId}:{stepIndex}:{keyHash}` | Step index marker |
| `sentinel:corr:cooldown` | `sentinel:corr:cooldown:{ruleId}` | Cooldown lock |
| `sentinel:corr:agg` | `sentinel:corr:agg:cnt:{ruleId}:{keyHash}[:{groupSuffix}]` | Aggregation counter |
| `sentinel:corr:agg` | `sentinel:corr:agg:set:{ruleId}:{keyHash}[:{groupSuffix}]` | Aggregation distinct-value set |
| `sentinel:corr:absence` | `sentinel:corr:absence:{ruleId}:{keyHash}` | Absence timer instance (JSON) |

Additionally, a global sorted set is maintained:

```
sentinel:corr:absence:index
```

This sorted set indexes all absence keys by their `expiresAt` timestamp for efficient expiry scans.

### Sequence instance key

```
sentinel:corr:seq:{ruleId}:{keyHash}
```

Stores the full `CorrelationInstance` object as a JSON string. The `keyHash` is a 16-character SHA-256 prefix derived from the event's correlation key values.

**TTL**: Anchored to the original window start time. On creation, the TTL is `windowMinutes * 60_000`. On subsequent advances, the TTL is recalculated as `instance.expiresAt - Date.now()` -- that is, the time remaining until the original window expires. This prevents step advancement from extending the window beyond its original deadline.

### Step index key

```
sentinel:corr:idx:{ruleId}:{stepIndex}:{keyHash}
```

A lightweight marker (`value: "1"`) that records which step index is current for a given key hash. TTL matches the sequence instance key.

### Cooldown key

```
sentinel:corr:cooldown:{ruleId}
```

Present during the cooldown window. Value is `"1"`. TTL is `cooldownMinutes * 60_000`. The `SET NX PX` operation on this key is the atomic cooldown check.

### Aggregation counter key

```
sentinel:corr:agg:cnt:{ruleId}:{keyHash}
sentinel:corr:agg:cnt:{ruleId}:{keyHash}:g:{encodedGroupValue}
```

An integer counter incremented atomically by the `AGG_INCR_LUA` script. TTL is `windowMinutes * 60_000`, refreshed on each increment. When the counter reaches the threshold and cooldown passes, the alert fires and the key is atomically deleted in the same Lua script.

The `groupByField` value is encoded with `encodeURIComponent` before embedding in the key to prevent structural delimiter collisions (a `:` in the group value would break key segment parsing).

### Aggregation distinct-value set key

```
sentinel:corr:agg:set:{ruleId}:{keyHash}
sentinel:corr:agg:set:{ruleId}:{keyHash}:g:{encodedGroupValue}
```

A Redis set tracking distinct values of a `countField` within the window, managed by the `AGG_SADD_LUA` script. Members are string representations of the field value. TTL is `windowMinutes * 60_000`. The alert fires when `SCARD` reaches the threshold; the set is atomically deleted in the same Lua script.

### Absence instance key

```
sentinel:corr:absence:{ruleId}:{keyHash}
```

Stores a `CorrelationInstance` as a JSON string representing the pending absence timer. TTL is `graceMinutes * 60_000 + 60_000` (grace period plus one minute buffer). The extra buffer ensures the background expiry handler can find the instance before Redis evicts it.

## Correlation key hashing

The correlation key identifies which events belong to the same "chain" of activity. The engine computes the key hash as follows:

```typescript
const values: Record<string, string> = {};
const parts: string[] = [];

for (const keyDef of config.correlationKey) {
  const raw = getField(event.payload, keyDef.field);
  if (raw == null) return null;  // Required field missing -- skip

  const strVal = String(raw);
  const alias = keyDef.alias ?? keyDef.field;
  values[alias] = strVal;
  parts.push(`${alias}=${strVal}`);
}

const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
```

If any required field is missing from the event payload, the engine returns `null` and skips the rule for that event entirely. This prevents partial-key state pollution where unrelated events could be incorrectly grouped.

The `values` record (human-readable key field values) is stored in the instance as `correlationKeyValues` and included in the alert `triggerData` for context.

## Instance state

A `CorrelationInstance` stores all state needed to advance a sequence:

```typescript
export interface CorrelationInstance {
  ruleId: string;
  orgId: string;
  correlationKeyHash: string;
  correlationKeyValues: Record<string, string>;
  currentStepIndex: number;
  startedAt: number;           // epoch ms
  expiresAt: number;           // epoch ms (startedAt + windowMinutes * 60_000)
  matchedSteps: MatchedStep[];
}

export interface MatchedStep {
  stepName: string;
  eventId: string;
  eventType: string;
  timestamp: number;           // epoch ms
  actor: string | null;        // payload.actor or payload.sender
  fields: Record<string, unknown>;  // full payload snapshot for cross-step conditions
}
```

The `fields` object in each `MatchedStep` contains the complete event payload at the time of the match. Cross-step conditions reference these fields using the format `"stepName.field.path"`, resolved by `resolveStepRef()`.

## Atomic compare-and-swap (CAS) for sequence advancement

Sequence instance advancement uses a Lua script (`SEQ_ADVANCE_LUA`) to prevent lost updates when two workers process events for the same correlation key concurrently.

### Problem

Without CAS, two workers could:

1. Both load the instance at `currentStepIndex = 0`.
2. Both advance to `currentStepIndex = 1`.
3. The second `SET` overwrites the first, but both workers believe they advanced the instance.

### Solution

The Lua script atomically:

1. Reads the current instance from Redis.
2. Checks that `currentStepIndex` matches the expected value (the value loaded before advancing).
3. Writes the new instance only if the check passes.

```lua
-- SEQ_ADVANCE_LUA
-- KEYS[1] = sequence instance key
-- ARGV[1] = expected currentStepIndex
-- ARGV[2] = new serialized instance JSON
-- ARGV[3] = TTL in milliseconds
-- Returns: 1 (success), 0 (stale/mismatch), -1 (key gone)

local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local ok, instance = pcall(cjson.decode, raw)
if not ok then return -1 end
if instance['currentStepIndex'] ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
```

When a CAS fails (returns `0`), the engine logs a warning and discards the advancement. The event that lost the race is effectively dropped for that step, which is the correct behavior -- the winning worker's advancement is canonical.

### When CAS is not used

New instances (step 0) use a plain `SET` because there is no prior state to compare against. The `expectedStepIndex` parameter is `null` for new instances.

## Aggregation modes

### Simple-count mode (INCR)

The `AGG_INCR_LUA` script atomically increments a counter, refreshes the window TTL, and checks if the threshold is reached:

```lua
local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if count >= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {count, 1}
end
return {count, 0}
```

The script refreshes the TTL on every increment via `PEXPIRE`. If the threshold is reached, the key is atomically deleted in the same script so no second worker can observe `count >= threshold` before the reset. The return value `[count, 1]` indicates the threshold was reached.

### Distinct-count mode (SADD)

The `AGG_SADD_LUA` script atomically adds a value to a set, refreshes the TTL, and checks if the distinct count reaches the threshold:

```lua
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local count = redis.call('SCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {count, 1}
end
return {count, 0}
```

This mode counts distinct values of a specified `countField`. For example, counting distinct IP addresses making failed auth attempts.

## Absence pattern tracking

Absence rules use a two-part storage strategy:

1. **Instance key**: `sentinel:corr:absence:{ruleId}:{keyHash}` stores the trigger event data as a `CorrelationInstance` JSON object.
2. **Sorted set index**: `sentinel:corr:absence:index` stores each absence key scored by its `expiresAt` timestamp.

When a trigger event arrives:
- The engine writes the instance key with TTL = `graceMinutes * 60_000 + 60_000`.
- The engine adds the key to the sorted set index via `ZADD`.

When an expected event arrives:
- The engine reads the instance, checks `absenceMatchConditions`, and if conditions pass, deletes both the instance key and the sorted set entry.
- Corrupted JSON in the instance triggers a delete-and-skip to prevent permanently blocking the rule.

When neither arrives:
- The background expiry handler uses `ZRANGEBYSCORE(index, -inf, now)` to efficiently find expired instances.
- For each expired key, it creates an absence alert and cleans up both the instance key and the sorted set entry.

## Serialization format

Instances are serialized with `JSON.stringify` and deserialized with `JSON.parse`. All numeric timestamps are stored as epoch milliseconds (JavaScript `number` type). BigInt values are not present in instance state.

Redis memory usage scales with the number of active sequences and absence timers, not the total number of rules.

## Concurrency guarantees

| Operation | Mechanism | Guarantee |
|---|---|---|
| Cooldown lock | `SET NX PX` | Exactly one worker acquires the lock per rule per window |
| Aggregation INCR | `AGG_INCR_LUA` Lua script | Atomic increment + threshold check + delete |
| Aggregation SADD | `AGG_SADD_LUA` Lua script | Atomic add + cardinality check + delete |
| Sequence advancement | `SEQ_ADVANCE_LUA` Lua CAS | Only the worker whose expected step index matches succeeds |
| Absence key creation | `SET NX PX` (atomic set-if-not-exists) | First trigger wins; subsequent triggers are ignored |
| Absence cancellation | `DEL` + `ZREM` | Last writer wins (benign -- both delete the same key) |

## TTL management and cleanup

| Key type | TTL | Cleanup mechanism |
|---|---|---|
| `sentinel:corr:seq:*` | `expiresAt - now` (anchored to window start) | Redis auto-eviction + explicit `DEL` on completion |
| `sentinel:corr:idx:*` | Same as parent sequence | Redis auto-eviction + pipeline `DEL` on completion |
| `sentinel:corr:cooldown:*` | `cooldownMinutes * 60_000` | Redis auto-eviction |
| `sentinel:corr:agg:cnt:*` | `windowMinutes * 60_000` (set on first INCR) | Redis auto-eviction + `DEL` on threshold |
| `sentinel:corr:agg:set:*` | `windowMinutes * 60_000` (refreshed on each SADD) | Redis auto-eviction + `DEL` on threshold |
| `sentinel:corr:absence:*` | `graceMinutes * 60_000 + 60_000` | Background expiry handler + Redis auto-eviction |

Sequence instances whose parent rule is deleted or paused are not actively cleaned up. They expire naturally via Redis TTL. The expiry handler skips instances whose `rule.status` is not `'active'` and deletes their keys.
