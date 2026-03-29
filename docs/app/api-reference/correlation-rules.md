# Correlation Rules API

Correlation rules detect multi-step attack patterns by correlating events across time, modules, and actors. Where a standard detection matches a single event against a single rule, a correlation rule matches a sequence of events — or a volume threshold, or the absence of an expected event — and fires a single `correlated` alert when the pattern completes.

In-flight correlation state is stored in Redis, scoped by rule ID and a correlation key hash. The state is automatically expired after the rule's `windowMinutes` elapses.

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header, and active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |
| `POST`, `PATCH` | editor, admin | `api:write` |
| `DELETE` | admin | `api:write` |

All create, update, and delete operations are recorded in the organisation's audit log.

---

## Correlation rule object

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Unique correlation rule identifier. |
| `orgId` | `string (UUID)` | Organisation that owns this rule. |
| `createdBy` | `string (UUID) \| null` | User ID of the creator. |
| `name` | `string` | Human-readable rule name. |
| `description` | `string \| null` | Optional description. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | Severity of alerts produced by this rule. |
| `status` | `"active" \| "paused" \| "deleted"` | Rule status. |
| `config` | `object` | Rule configuration JSONB. See [Correlation rule config](#correlation-rule-config). |
| `channelIds` | `string[]` | Notification channel UUIDs. |
| `slackChannelId` | `string \| null` | Slack channel ID for direct notifications. |
| `slackChannelName` | `string \| null` | Slack channel name (display only). |
| `cooldownMinutes` | `integer` | Minimum minutes between repeated alerts from this rule. |
| `lastTriggeredAt` | `string (ISO 8601) \| null` | Timestamp of the last alert this rule produced. |
| `createdAt` | `string (ISO 8601)` | Creation timestamp. |
| `updatedAt` | `string (ISO 8601)` | Last-updated timestamp. |

### Correlation rule status

| Status | Meaning |
|--------|---------|
| `active` | Rule is loaded by the correlation engine and evaluated on every event. |
| `paused` | Rule is not evaluated. In-flight Redis instances are preserved. |
| `deleted` | Rule has been soft-deleted. Excluded from all list and get responses. Redis instances are purged on deletion. |

---

## Correlation rule config

The `config` field is a JSONB object validated against the following structure. The required sub-fields depend on the value of `type`.

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"sequence" \| "aggregation" \| "absence"` | Yes | Correlation strategy. |
| `correlationKey` | `CorrelationKeyField[]` | Yes | Array of at least one field path. Events that share the same values for all key fields are correlated together. |
| `windowMinutes` | `number (>0)` | Yes | Maximum time window in which all steps or events must occur. |
| `steps` | `CorrelationStep[]` | Required if `type = "sequence"` | Ordered steps, minimum 2. |
| `aggregation` | `AggregationConfig` | Required if `type = "aggregation"` | Aggregation threshold config. |
| `absence` | `AbsenceConfig` | Required if `type = "absence"` | Absence detection config. |

### CorrelationKeyField

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | `string` | Yes | Dot-notation JSON path into the event payload (e.g., `repository.full_name`). |
| `alias` | `string` | No | Alias used as the key name in `triggerData.correlationKey`. Defaults to `field`. |

The correlation engine computes a SHA-256 hash over all key field values. Events that produce the same hash are placed in the same correlation instance. If any required key field is missing from an event payload, the event is skipped for that rule.

### CorrelationStep (sequence type)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string (≥1)` | Yes | Step name. Used as a reference key in cross-step conditions (e.g., `StepName.field.path`). |
| `eventFilter` | `EventFilter` | Yes | Event matching criteria for this step. |
| `withinMinutes` | `number (>0)` | No | Maximum minutes allowed between this step and the previous step. If the elapsed time exceeds this value, the in-flight instance is discarded. |
| `matchConditions` | `CrossStepCondition[]` | No | Conditions that compare fields on the current event against fields captured in previous steps. Default: `[]`. |

### EventFilter

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `moduleId` | `string` | No | Only match events from this module. |
| `eventType` | `string \| string[]` | No | Only match events with this type (or any type in the array). |
| `conditions` | `Condition[]` | No | Field-level conditions evaluated against the event payload. All conditions must pass (AND logic). |

### Condition

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | Dot-notation path into the event payload. |
| `operator` | `"==" \| "!=" \| ">" \| "<" \| ">=" \| "<="` | Comparison operator. |
| `value` | `unknown` | Value to compare against. |

### CrossStepCondition

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | Dot-notation path into the **current** event's payload. |
| `operator` | `"==" \| "!="` | Comparison operator. |
| `ref` | `string` | Reference to a previous step's field. Format: `StepName.field.path` (e.g., `ProtectionDisabled.sender.login`). The `StepName` must match a step `name` defined earlier in the `steps` array. |

### AggregationConfig (aggregation type)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `eventFilter` | `EventFilter` | Yes | Filter for events to count. |
| `threshold` | `integer (≥1)` | Yes | Number of events (or distinct field values) that triggers the alert. |
| `countField` | `string` | No | If set, count **distinct** values of this field path rather than counting total events. |
| `groupByField` | `string` | No | Partition the counter by distinct values of this field path. Each unique value maintains an independent counter. |

### AbsenceConfig (absence type)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trigger.eventFilter` | `EventFilter` | Yes | Filter for the trigger event that starts the absence timer. |
| `expected.eventFilter` | `EventFilter` | Yes | Filter for the expected event that cancels the absence timer. |
| `expected.matchConditions` | `AbsenceMatchCondition[]` | No | Conditions linking the expected event's fields to the trigger event's fields. |
| `graceMinutes` | `number (>0)` | Yes | Minutes to wait for the expected event. If the expected event does not arrive within `graceMinutes`, an alert fires. |

### AbsenceMatchCondition

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | Dot-notation path into the **expected** event's payload. |
| `operator` | `"==" \| "!="` | Comparison operator. |
| `triggerField` | `string` | Dot-notation path into the **trigger** event's payload (captured in `matchedSteps[0].fields`). |

---

## Example: multi-step sequence rule

The following rule detects a branch protection bypass followed by a secret push — a common attack pattern used to quietly exfiltrate credentials.

```json
{
  "name": "Branch Protection Bypass + Secret Push",
  "description": "Detects when branch protection is disabled and a secret is pushed to the same repository within 30 minutes by the same actor.",
  "severity": "critical",
  "cooldownMinutes": 60,
  "channelIds": ["chan-uuid-..."],
  "config": {
    "type": "sequence",
    "correlationKey": [
      { "field": "repository.full_name", "alias": "repo" }
    ],
    "windowMinutes": 30,
    "steps": [
      {
        "name": "ProtectionDisabled",
        "eventFilter": {
          "moduleId": "github",
          "eventType": "github.branch_protection.disabled",
          "conditions": []
        }
      },
      {
        "name": "SecretPushed",
        "eventFilter": {
          "moduleId": "github",
          "eventType": "github.push.secrets_detected",
          "conditions": []
        },
        "withinMinutes": 30,
        "matchConditions": [
          {
            "field": "sender.login",
            "operator": "==",
            "ref": "ProtectionDisabled.sender.login"
          }
        ]
      }
    ]
  }
}
```

**How this rule works:**

1. When a `github.branch_protection.disabled` event arrives, the engine starts a new correlation instance keyed on `repository.full_name`. The instance expires after 30 minutes.
2. When a `github.push.secrets_detected` event arrives for the same repository within 30 minutes, the engine checks that `sender.login` on the new event equals `sender.login` captured from the `ProtectionDisabled` step.
3. If the cross-step condition passes, the sequence is complete. The engine checks the 60-minute cooldown, then emits a `critical` alert and notifies the configured channels.

---

## Example: aggregation rule

The following rule fires when the same user generates more than 50 failed login events within 10 minutes (brute-force detection).

```json
{
  "name": "Brute Force: Failed Logins",
  "severity": "high",
  "cooldownMinutes": 30,
  "config": {
    "type": "aggregation",
    "correlationKey": [
      { "field": "actor.login", "alias": "user" }
    ],
    "windowMinutes": 10,
    "aggregation": {
      "eventFilter": {
        "moduleId": "infra",
        "eventType": "infra.auth.failed",
        "conditions": []
      },
      "threshold": 50
    }
  }
}
```

---

## Example: absence rule

The following rule fires when a repository is archived but no post-archive audit entry is recorded within 15 minutes.

```json
{
  "name": "Repository Archived Without Audit",
  "severity": "medium",
  "cooldownMinutes": 0,
  "config": {
    "type": "absence",
    "correlationKey": [
      { "field": "repository.full_name", "alias": "repo" }
    ],
    "windowMinutes": 15,
    "absence": {
      "trigger": {
        "eventFilter": {
          "moduleId": "github",
          "eventType": "github.repository.archived"
        }
      },
      "expected": {
        "eventFilter": {
          "moduleId": "github",
          "eventType": "github.audit.repository_archived"
        },
        "matchConditions": [
          {
            "field": "repository.full_name",
            "operator": "==",
            "triggerField": "repository.full_name"
          }
        ]
      },
      "graceMinutes": 15
    }
  }
}
```

---

## Endpoints

### List correlation rules

```
GET /api/correlation-rules
```

Returns a paginated list of correlation rules. Soft-deleted rules (`status = "deleted"`) are excluded by default.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `"active" \| "paused" \| "deleted"` | No | Filter by status. When omitted, deleted rules are excluded. |
| `type` | `"sequence" \| "aggregation" \| "absence"` | No | Filter by correlation type (reads from `config.type`). |
| `search` | `string (max 255)` | No | Case-insensitive substring match on `name`. |
| `page` | `integer (≥1)` | No | Page number. Default: `1`. |
| `limit` | `integer (1–100)` | No | Results per page. Default: `20`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "corr-uuid-...",
      "name": "Branch Protection Bypass + Secret Push",
      "description": "...",
      "severity": "critical",
      "status": "active",
      "config": { "type": "sequence", "correlationKey": [...], "windowMinutes": 30, "steps": [...] },
      "channelIds": ["chan-uuid-..."],
      "cooldownMinutes": 60,
      "lastTriggeredAt": null,
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-15T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 8,
    "totalPages": 1
  }
}
```

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/correlation-rules?type=sequence&status=active"
```

---

### Get correlation rule

```
GET /api/correlation-rules/:id
```

Returns a single correlation rule.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Correlation rule ID. |

**Response `200 OK`**

```json
{
  "data": { /* full correlation rule object */ }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Rule found. |
| `404` | Rule not found, deleted, or belongs to a different organisation. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/correlation-rules/corr-uuid-..."
```

---

### Create correlation rule

```
POST /api/correlation-rules
```

Creates a new correlation rule. The `config` field is fully validated against the correlation rule config schema before insertion.

**Required role:** `admin` or `editor`

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string (1–255)` | Yes | Rule name. |
| `description` | `string (max 1000)` | No | Optional description. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | No | Default: `"high"`. |
| `config` | `CorrelationRuleConfig` | Yes | Validated correlation config object. |
| `channelIds` | `string[] (UUIDs)` | No | Notification channel IDs. Default: `[]`. |
| `slackChannelId` | `string` | No | Slack channel ID. |
| `slackChannelName` | `string` | No | Slack channel name. |
| `cooldownMinutes` | `integer (0–1440)` | No | Default: `0`. |

**Response `201 Created`**

```json
{
  "data": { /* full correlation rule object */ }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `201` | Rule created. |
| `400` | Validation error (invalid config structure, wrong type/field combination, etc.). |
| `403` | Insufficient role or missing scope. |

**cURL example**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Branch Protection Bypass + Secret Push",
    "severity": "critical",
    "cooldownMinutes": 60,
    "channelIds": ["chan-uuid-..."],
    "config": {
      "type": "sequence",
      "correlationKey": [
        { "field": "repository.full_name", "alias": "repo" }
      ],
      "windowMinutes": 30,
      "steps": [
        {
          "name": "ProtectionDisabled",
          "eventFilter": {
            "moduleId": "github",
            "eventType": "github.branch_protection.disabled"
          }
        },
        {
          "name": "SecretPushed",
          "eventFilter": {
            "moduleId": "github",
            "eventType": "github.push.secrets_detected"
          },
          "withinMinutes": 30,
          "matchConditions": [
            {
              "field": "sender.login",
              "operator": "==",
              "ref": "ProtectionDisabled.sender.login"
            }
          ]
        }
      ]
    }
  }' \
  "http://localhost:4000/api/correlation-rules"
```

---

### Update correlation rule

```
PATCH /api/correlation-rules/:id
```

Performs a partial update. At least one field must be provided. You cannot update a rule with status `deleted`.

**Required role:** `admin` or `editor`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Correlation rule ID. |

**Request body** (all fields optional; at least one required)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string (1–255)` | New name. |
| `description` | `string (max 1000) \| null` | New description. Send `null` to clear. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | New severity. |
| `status` | `"active" \| "paused"` | Status transition. |
| `config` | `CorrelationRuleConfig` | Replace config. Fully validated. In-flight Redis instances are purged when `config` or `status` is updated, because old instances carry state from the previous configuration and cannot be meaningfully continued. |
| `channelIds` | `string[] (UUIDs)` | Replace channel associations. |
| `slackChannelId` | `string \| null` | Update Slack channel ID. |
| `slackChannelName` | `string \| null` | Update Slack channel name. |
| `cooldownMinutes` | `integer (0–1440)` | New cooldown. |

**Response `200 OK`**

```json
{
  "data": { /* updated correlation rule object */ }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Rule updated. |
| `400` | Validation error or rule is deleted. |
| `404` | Rule not found. |

**cURL example — pause a rule**

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "paused" }' \
  "http://localhost:4000/api/correlation-rules/corr-uuid-..."
```

---

### Delete correlation rule

```
DELETE /api/correlation-rules/:id
```

Soft-deletes a correlation rule (`status = "deleted"`). All active Redis instances for the rule are purged. The operation is recorded in the audit log.

**Required role:** `admin`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Correlation rule ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "corr-uuid-...",
    "name": "Branch Protection Bypass + Secret Push",
    "status": "deleted"
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Rule deleted and Redis instances purged. |
| `404` | Rule not found. |

**cURL example**

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/correlation-rules/corr-uuid-..."
```

---

### List active instances

```
GET /api/correlation-rules/:id/instances
```

Returns all in-flight correlation instances for a rule. Instances are the partial-match state stored in Redis while the engine waits for subsequent steps to arrive. Use this endpoint to inspect in-progress detections.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Correlation rule ID. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "ruleId": "corr-uuid-...",
      "orgId": "org-uuid-...",
      "correlationKeyHash": "a1b2c3d4e5f6a7b8",
      "correlationKeyValues": { "repo": "my-org/my-repo" },
      "currentStepIndex": 0,
      "startedAt": 1706265600000,
      "expiresAt": 1706267400000,
      "matchedSteps": [
        {
          "stepName": "ProtectionDisabled",
          "eventId": "evt-uuid-...",
          "eventType": "github.branch_protection.disabled",
          "timestamp": 1706265600000,
          "actor": "octocat",
          "fields": { "sender": { "login": "octocat" }, "repository": { "full_name": "my-org/my-repo" } }
        }
      ]
    }
  ],
  "meta": {
    "total": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `correlationKeyHash` | `string` | SHA-256-derived 16-character hex hash of the correlation key values. Used as the Redis key suffix. |
| `correlationKeyValues` | `object` | Human-readable key-value pairs corresponding to the correlation key fields. |
| `currentStepIndex` | `integer` | Zero-based index of the last matched step. The engine awaits step `currentStepIndex + 1`. |
| `startedAt` | `number` | Unix epoch milliseconds when step 0 matched. |
| `expiresAt` | `number` | Unix epoch milliseconds when the instance will be discarded if the sequence is not completed. |
| `matchedSteps` | `MatchedStep[]` | Steps matched so far. See [Trigger data structure](./alerts.md#trigger-data-structure) for field descriptions. |

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Instances returned (empty array if none). |
| `404` | Rule not found. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/correlation-rules/corr-uuid-.../instances"
```

---

### Clear active instances

```
DELETE /api/correlation-rules/:id/instances
```

Deletes all in-flight Redis instances for a rule. Use this to reset a rule's state, for example after a false trigger or a configuration update. The operation is recorded in the audit log.

**Required role:** `admin` or `editor`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Correlation rule ID. |

**Response `200 OK`**

```json
{
  "data": {
    "deletedCount": 3
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Instances cleared. `deletedCount` reflects the number of Redis keys removed. |
| `404` | Rule not found. |

**cURL example**

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/correlation-rules/corr-uuid-.../instances"
```
