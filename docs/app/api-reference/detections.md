# Detections API

Detections are the core detection rules in Sentinel. Each detection belongs to a module, carries a set of evaluation rules, and fires alerts when matching events arrive. Detections can be created manually or instantiated from a module-provided template.

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header. All `/api/*` routes also require active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |
| `POST`, `PATCH`, `DELETE` | editor, admin | `api:write` |

---

## Detection object

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Unique detection identifier. |
| `orgId` | `string (UUID)` | Organisation that owns this detection. |
| `createdBy` | `string (UUID) \| null` | User ID of the creator. |
| `moduleId` | `string` | Module that this detection belongs to (e.g., `github`, `registry`, `chain`, `infra`, `aws`). |
| `templateId` | `string \| null` | Template slug used to create this detection, if any. |
| `name` | `string` | Human-readable display name. |
| `description` | `string \| null` | Optional longer description. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | Severity level of alerts this detection produces. |
| `status` | `"active" \| "paused" \| "error" \| "disabled"` | Current status. See [Detection status](#detection-status). |
| `channelIds` | `string[]` | Array of notification channel UUIDs associated with this detection. |
| `slackChannelId` | `string \| null` | Slack channel ID for direct Slack notifications. |
| `slackChannelName` | `string \| null` | Slack channel name (display only). |
| `cooldownMinutes` | `integer` | Minimum minutes between repeated alerts from this detection. `0` means no cooldown. |
| `lastTriggeredAt` | `string (ISO 8601) \| null` | Timestamp of the last alert fired by this detection. |
| `config` | `object` | Detection-level JSONB config. See [Detection config structure](#detection-config-structure). |
| `createdAt` | `string (ISO 8601)` | Creation timestamp. |
| `updatedAt` | `string (ISO 8601)` | Last-updated timestamp. |

### Detection status

| Status | Meaning |
|--------|---------|
| `active` | Detection and all its rules are actively evaluated. |
| `paused` | Detection and all its rules are suspended. No alerts fire. |
| `error` | A system error has occurred during evaluation (set by worker). |
| `disabled` | Detection has been archived (soft-deleted). Cannot be updated. |

Transitioning a detection to `paused` automatically sets all associated rules to `paused`. Transitioning back to `active` reactivates them. A `disabled` detection cannot be updated or un-archived via the API.

### Detection config structure

The `config` field is a free-form JSONB object whose contents depend on the module. For template-instantiated detections, it stores the merged values of all template inputs and overrides so the edit form can pre-fill on next load. For manually created detections, it mirrors the merged `config` maps from all rules.

Example for a GitHub repository-visibility detection:

```json
{
  "repoName": "my-org/my-repo",
  "visibility": "public"
}
```

---

## Rule object

Each detection has one or more rules. Rules are evaluated in ascending `priority` order.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Unique rule identifier. |
| `detectionId` | `string (UUID)` | Parent detection. |
| `orgId` | `string (UUID)` | Organisation that owns this rule. |
| `moduleId` | `string` | Module providing the evaluator for this rule type. |
| `ruleType` | `string` | Evaluator type key, scoped to the module (e.g., `github.repo_visibility`). |
| `config` | `object` | Rule-specific JSONB config consumed by the evaluator. |
| `status` | `"active" \| "paused" \| "disabled"` | Rule-level status. Mirrors detection status. |
| `priority` | `integer (0–100)` | Evaluation order. Lower values run first. Default: `50`. |
| `action` | `"alert" \| "log" \| "suppress"` | Action taken when this rule matches. |
| `createdAt` | `string (ISO 8601)` | Creation timestamp. |
| `updatedAt` | `string (ISO 8601)` | Last-updated timestamp. |

---

## Endpoints

### List detections

```
GET /api/detections
```

Returns a paginated list of detections for the authenticated organisation. Results are ordered by `createdAt` descending.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `moduleId` | `string` | No | Filter by module ID. |
| `status` | `"active" \| "paused" \| "error" \| "disabled"` | No | Filter by detection status. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | No | Filter by severity. |
| `search` | `string (max 255)` | No | Case-insensitive substring match on `name`. |
| `page` | `integer (≥1)` | No | Page number. Default: `1`. |
| `limit` | `integer (1–100)` | No | Results per page. Default: `20`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "d1e2f3a4-...",
      "moduleId": "github",
      "templateId": "github-repo-visibility",
      "name": "Public Repository Created",
      "description": "Fires when a repository is made public.",
      "severity": "high",
      "status": "active",
      "cooldownMinutes": 0,
      "lastTriggeredAt": null,
      "ruleCount": 1,
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-15T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

The list response includes `ruleCount` (count of non-disabled rules) instead of the full rules array.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/detections?moduleId=github&status=active&page=1&limit=10"
```

---

### Get detection

```
GET /api/detections/:id
```

Returns a single detection, including its full `rules` array.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Detection ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "d1e2f3a4-...",
    "orgId": "org-uuid-...",
    "createdBy": "user-uuid-...",
    "moduleId": "github",
    "templateId": "github-repo-visibility",
    "name": "Public Repository Created",
    "description": "Fires when a repository is made public.",
    "severity": "high",
    "status": "active",
    "channelIds": ["chan-uuid-..."],
    "slackChannelId": null,
    "slackChannelName": null,
    "cooldownMinutes": 0,
    "lastTriggeredAt": null,
    "config": { "repoName": "my-org/my-repo" },
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-01-15T10:00:00.000Z",
    "rules": [
      {
        "id": "rule-uuid-...",
        "detectionId": "d1e2f3a4-...",
        "orgId": "org-uuid-...",
        "moduleId": "github",
        "ruleType": "github.repo_visibility",
        "config": { "visibility": "public" },
        "status": "active",
        "priority": 50,
        "action": "alert",
        "createdAt": "2026-01-15T10:00:00.000Z",
        "updatedAt": "2026-01-15T10:00:00.000Z"
      }
    ]
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Detection found and returned. |
| `404` | Detection not found or belongs to a different organisation. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/detections/d1e2f3a4-0000-0000-0000-000000000001"
```

---

### Create detection

```
POST /api/detections
```

Creates a new detection with one or more rules.

**Required role:** `admin` or `editor`

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `moduleId` | `string` | Yes | Module ID for the detection. |
| `templateSlug` | `string` | No | Optional template slug (informational only; does not instantiate a template). Use `POST /api/detections/from-template` to derive rules from a template. |
| `name` | `string (1–255)` | Yes | Detection name. |
| `description` | `string (max 1000)` | No | Optional description. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | No | Default: `"high"`. |
| `channelIds` | `string[] (UUIDs)` | No | Notification channel IDs. Default: `[]`. |
| `slackChannelId` | `string` | No | Slack channel ID. |
| `slackChannelName` | `string` | No | Slack channel name (display only). |
| `cooldownMinutes` | `integer (0–1440)` | No | Cooldown between alerts. Default: `0`. |
| `config` | `object` | No | Detection-level config. Default: `{}`. |
| `rules` | `Rule[]` | Yes | Array of at least one rule. See rule fields below. |

**Rule fields (within `rules` array)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ruleType` | `string` | Yes | Evaluator type key. |
| `config` | `object` | Yes | Rule-specific config consumed by the evaluator. |
| `action` | `"alert" \| "log" \| "suppress"` | No | Default: `"alert"`. |
| `priority` | `integer (0–100)` | No | Evaluation priority. Default: `50`. |

**Response `201 Created`**

```json
{
  "data": {
    "detection": { /* full detection object */ },
    "rules": [ /* array of created rule objects */ ]
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `201` | Detection and rules created. |
| `400` | Validation error. |
| `403` | Insufficient role or missing scope. |

**cURL example**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{
    "moduleId": "github",
    "name": "Public Repository Created",
    "severity": "high",
    "cooldownMinutes": 60,
    "channelIds": ["chan-uuid-..."],
    "config": {},
    "rules": [
      {
        "ruleType": "github.repo_visibility",
        "config": { "visibility": "public" },
        "action": "alert",
        "priority": 50
      }
    ]
  }' \
  "http://localhost:4000/api/detections"
```

> Note: When authenticating with a session cookie (rather than a Bearer token), all state-changing requests must include the `X-Sentinel-Request` header with any non-empty value as a CSRF defense token.

---

### Create detection from template

```
POST /api/detections/from-template
```

Instantiates a detection from a module-provided template. The template's `rules` array is used to generate rule configs, with `{{placeholder}}` tokens replaced by the values in `inputs`. A `{{token}}` that occupies the entire string value is replaced with the typed value from `inputs`; partial occurrences are replaced as strings.

**Required role:** `admin` or `editor`

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `moduleId` | `string` | Yes | Module ID that owns the template. |
| `templateSlug` | `string` | Yes | URL-safe template slug. |
| `name` | `string (1–255)` | No | Override the template's default name. |
| `channelIds` | `string[] (UUIDs)` | No | Notification channel IDs. Default: `[]`. |
| `slackChannelId` | `string` | No | Slack channel ID. |
| `slackChannelName` | `string` | No | Slack channel name. |
| `cooldownMinutes` | `integer (0–1440)` | No | Default: `5`. |
| `inputs` | `object` | No | Key-value pairs that replace `{{placeholder}}` tokens in the template's rule configs. Default: `{}`. |
| `overrides` | `object` | No | Detection-level config overrides merged on top of `inputs`. Default: `{}`. |

The API returns a `400` error with a `Missing required inputs: ...` message if any `{{placeholder}}` tokens remain unresolved after applying `inputs`.

**Response `201 Created`**

```json
{
  "data": {
    "detection": { /* full detection object */ },
    "rules": [ /* array of created rule objects */ ]
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `201` | Detection instantiated from template. |
| `400` | Validation error or unresolved template placeholders. |
| `404` | Module or template slug not found. |

**cURL example**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "moduleId": "github",
    "templateSlug": "github-repo-visibility",
    "cooldownMinutes": 30,
    "channelIds": ["chan-uuid-..."],
    "inputs": {
      "visibility": "public"
    }
  }' \
  "http://localhost:4000/api/detections/from-template"
```

---

### Update detection

```
PATCH /api/detections/:id
```

Performs a partial update on a detection. At least one field must be provided. You cannot update a detection with status `disabled`.

**Required role:** `admin` or `editor`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Detection ID. |

**Request body** (all fields optional; at least one required)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string (1–255)` | New name. |
| `description` | `string (max 1000) \| null` | New description. Send `null` to clear. |
| `status` | `"active" \| "paused"` | Status transition. Cascades to all rules. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | New severity. |
| `channelIds` | `string[] (UUIDs)` | Replace channel associations. |
| `slackChannelId` | `string \| null` | Update Slack channel ID. |
| `slackChannelName` | `string \| null` | Update Slack channel name. |
| `cooldownMinutes` | `integer (0–1440)` | New cooldown. |
| `config` | `object` | Replace detection config. |
| `rules` | `Rule[]` | Replace all rules (delete existing, insert new). `config` is also updated to the merged rule configs. |
| `templateSlug` | `string` | Re-derive rules from this template. Requires `inputs`. |
| `inputs` | `object` | Template inputs for a template-based rule rebuild. |
| `overrides` | `object` | Detection-level config overrides for a template-based rule rebuild. |

When `rules` is provided, all existing rules are deleted and replaced atomically.

When `templateSlug` is provided alongside `inputs`, the template rules are rebuilt and all existing rules are replaced atomically. The detection `config` is updated to `{ ...inputs, ...overrides }`.

**Response `200 OK`**

```json
{
  "data": { /* updated detection object (without rules) */ }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Detection updated. |
| `400` | Validation error, archived detection, or unresolved template placeholders. |
| `404` | Detection not found. |

**cURL example — pause a detection**

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "paused" }' \
  "http://localhost:4000/api/detections/d1e2f3a4-0000-0000-0000-000000000001"
```

---

### Delete detection

```
DELETE /api/detections/:id
```

Archives a detection (soft delete). Sets the detection status to `disabled` and disables all associated rules. Archived detections cannot be queried by the engine or updated via the API.

**Required role:** `admin`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Detection ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "d1e2f3a4-...",
    "name": "Public Repository Created",
    "status": "disabled"
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Detection archived. |
| `404` | Detection not found or belongs to a different organisation. |

**cURL example**

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/detections/d1e2f3a4-0000-0000-0000-000000000001"
```

---

### Resolve template

```
GET /api/detections/resolve-template
```

Returns the full template definition for a given module ID and template slug. Use this endpoint to preview the template's rules, inputs, and default values before calling `POST /api/detections/from-template`.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `moduleId` | `string` | Yes | Module ID. |
| `slug` | `string` | Yes | Template slug. |

**Response `200 OK`**

```json
{
  "data": {
    "template": {
      "slug": "github-repo-visibility",
      "name": "Repository Made Public",
      "description": "Fires when a repository visibility changes to public.",
      "category": "code-protection",
      "severity": "high",
      "rules": [
        {
          "ruleType": "github.repo_visibility",
          "config": { "visibility": "{{visibility}}" },
          "action": "alert",
          "priority": 50
        }
      ],
      "inputs": [
        {
          "key": "visibility",
          "label": "Visibility",
          "type": "select",
          "required": true,
          "options": [
            { "label": "Public", "value": "public" },
            { "label": "Private", "value": "private" }
          ]
        }
      ]
    }
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Template found. |
| `404` | Module or template not found. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/detections/resolve-template?moduleId=github&slug=github-repo-visibility"
```

---

### Get rule UI schema

```
GET /api/detections/rule-schema
```

Returns the `uiSchema` array for a given `ruleType`. The UI schema describes the fields that the detection edit form should render for a rule's `config` object. If the rule type is unknown, an empty array is returned (graceful degradation).

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ruleType` | `string` | Yes | Rule type key (e.g., `github.repo_visibility`). |

**Response `200 OK`**

```json
{
  "data": {
    "uiSchema": [
      {
        "key": "visibility",
        "label": "Visibility",
        "type": "select",
        "required": true,
        "options": [
          { "label": "Public", "value": "public" },
          { "label": "Private", "value": "private" }
        ]
      }
    ]
  }
}
```

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/detections/rule-schema?ruleType=github.repo_visibility"
```

---

### Test detection (dry run)

```
POST /api/detections/:id/test
```

Dry-runs a detection against a test event. No alert is created, no notifications are sent, and no state is changed. Returns whether the detection would have triggered and which rules matched.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Detection ID. |

**Request body** (provide exactly one of `eventId` or `event`)

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | `string (UUID)` | ID of an existing event in your organisation to test against. |
| `event` | `object` | Synthetic event object. See fields below. |

**Synthetic event fields (within `event`)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `eventType` | `string` | Yes | Event type string (e.g., `github.repository.publicized`). |
| `payload` | `object` | Yes | Free-form event payload object. |

**Response `200 OK`**

```json
{
  "data": {
    "wouldTrigger": true,
    "suppressed": false,
    "candidates": [
      {
        "detectionId": "d1e2f3a4-...",
        "ruleId": "rule-uuid-...",
        "action": "alert"
      }
    ],
    "rulesEvaluated": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `wouldTrigger` | `boolean` | `true` if at least one rule matched. |
| `suppressed` | `boolean` | `true` if the detection would have been suppressed by the cooldown. |
| `candidates` | `object[]` | Rules that matched. |
| `rulesEvaluated` | `integer` | Total number of rules evaluated. |

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Dry run completed. |
| `400` | Neither `eventId` nor `event` provided. |
| `404` | Detection or referenced event not found. |

**cURL example**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "eventType": "github.repository.publicized",
      "payload": {
        "repository": { "full_name": "my-org/my-repo", "visibility": "public" },
        "sender": { "login": "octocat" }
      }
    }
  }' \
  "http://localhost:4000/api/detections/d1e2f3a4-0000-0000-0000-000000000001/test"
```
