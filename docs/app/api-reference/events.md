# Events API

Events are the raw data records ingested by Sentinel from all monitored modules. Each event represents a discrete occurrence -- a GitHub webhook delivery, a container image push, a blockchain transaction, a CloudTrail action, or an infrastructure scan result. Events are created by the worker pipeline and are read-only from the API.

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header, and active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |

---

## Event object

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Unique event identifier. |
| `orgId` | `string (UUID)` | Organisation that owns this event. |
| `moduleId` | `string` | Module that produced this event (e.g., `github`, `registry`, `chain`, `infra`, `aws`). |
| `eventType` | `string` | Fully-qualified event type string (e.g., `github.repository.publicized`). |
| `externalId` | `string \| null` | External identifier from the source system (e.g., GitHub delivery ID). |
| `payload` | `object` | Full normalized event payload. Structure varies by module and event type. |
| `occurredAt` | `string (ISO 8601) \| null` | Timestamp when the event originally occurred in the source system. |
| `receivedAt` | `string (ISO 8601)` | Timestamp when Sentinel received and stored the event. |

---

## Endpoints

### List events

```
GET /api/events
```

Returns a paginated, filtered list of events for the authenticated organisation. Results are ordered by `receivedAt` descending.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `moduleId` | `string` | No | Filter by module ID. |
| `eventType` | `string` | No | Filter by event type. |
| `search` | `string (max 255)` | No | Case-insensitive substring match on `externalId`, `eventType`, or `payload` (cast to text). |
| `from` | `string (ISO 8601 datetime)` | No | Return events received at or after this time. |
| `to` | `string (ISO 8601 datetime)` | No | Return events received at or before this time. |
| `page` | `integer (>=1)` | No | Page number. Default: `1`. |
| `limit` | `integer (1-100)` | No | Results per page. Default: `20`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "evt-uuid-...",
      "orgId": "org-uuid-...",
      "moduleId": "github",
      "eventType": "github.repository.publicized",
      "externalId": "12345678",
      "payload": {
        "repository": { "full_name": "my-org/my-repo", "visibility": "public" },
        "sender": { "login": "octocat" }
      },
      "occurredAt": "2026-01-15T10:04:55.000Z",
      "receivedAt": "2026-01-15T10:04:56.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1024,
    "totalPages": 52
  }
}
```

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/events?moduleId=github&eventType=github.repository.publicized&page=1&limit=10"
```

---

### Get event

```
GET /api/events/:id
```

Returns a single event.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Event ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "evt-uuid-...",
    "orgId": "org-uuid-...",
    "moduleId": "github",
    "eventType": "github.repository.publicized",
    "externalId": "12345678",
    "payload": { "..." : "..." },
    "occurredAt": "2026-01-15T10:04:55.000Z",
    "receivedAt": "2026-01-15T10:04:56.000Z"
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Event found and returned. |
| `404` | Event not found or belongs to a different organisation. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/events/evt-uuid-..."
```

---

### Entity timeline

```
GET /api/events/timeline
```

Returns a cross-module event timeline for a given entity. The endpoint performs a case-insensitive text search across all event payloads (cast to text) for the provided entity string. Use this to build unified activity timelines for entities that appear across multiple modules (e.g., a repository name, a user login, or an IP address).

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity` | `string (1-500 chars)` | Yes | Entity string to search for across all event payloads. |
| `from` | `string (ISO 8601 datetime)` | No | Start of the time range (based on `occurredAt`). |
| `to` | `string (ISO 8601 datetime)` | No | End of the time range (based on `occurredAt`). |
| `limit` | `integer (1-500)` | No | Maximum results. Default: `100`. |

**Response `200 OK`**

```json
{
  "entity": "my-org/my-repo",
  "count": 15,
  "data": [
    {
      "id": "evt-uuid-...",
      "moduleId": "github",
      "eventType": "github.push",
      "externalId": "12345",
      "occurredAt": "2026-01-15T10:00:00.000Z",
      "receivedAt": "2026-01-15T10:00:01.000Z",
      "payload": { "..." : "..." }
    }
  ]
}
```

Results are ordered by `occurredAt` ascending (chronological order).

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/events/timeline?entity=my-org/my-repo&limit=50"
```

---

### Event frequency

```
GET /api/events/frequency
```

Returns daily event counts grouped by `moduleId` and `eventType`. Use this for trend analysis and dashboards.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `moduleId` | `string` | No | Filter by module ID. |
| `eventType` | `string` | No | Filter by event type. |
| `from` | `string (ISO 8601 datetime)` | No | Start of the time range (based on `occurredAt`). |
| `to` | `string (ISO 8601 datetime)` | No | End of the time range (based on `occurredAt`). |

**Response `200 OK`**

```json
{
  "data": [
    {
      "date": "2026-01-15",
      "moduleId": "github",
      "eventType": "github.push",
      "count": 42
    },
    {
      "date": "2026-01-15",
      "moduleId": "registry",
      "eventType": "registry.image.pushed",
      "count": 8
    }
  ]
}
```

Results are ordered by date descending.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/events/frequency?moduleId=github&from=2026-01-01T00:00:00Z"
```

---

### Payload search

```
GET /api/events/payload-search
```

Queries events by matching a specific field value within the JSONB payload using PostgreSQL's `#>>` operator. This provides exact-match field-level search without casting the entire payload to text.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `field` | `string (1-200 chars)` | Yes | Dot-notation JSON path (e.g., `address` or `sender.login`). |
| `value` | `string (1-500 chars)` | Yes | Exact value to match at the specified path. |
| `moduleId` | `string` | No | Filter by module ID. |
| `eventType` | `string` | No | Filter by event type. |
| `from` | `string (ISO 8601 datetime)` | No | Start of the time range (based on `occurredAt`). |
| `to` | `string (ISO 8601 datetime)` | No | End of the time range (based on `occurredAt`). |
| `limit` | `integer (1-100)` | No | Maximum results. Default: `20`. |

**Response `200 OK`**

```json
{
  "field": "sender.login",
  "value": "octocat",
  "count": 12,
  "data": [
    {
      "id": "evt-uuid-...",
      "orgId": "org-uuid-...",
      "moduleId": "github",
      "eventType": "github.push",
      "externalId": "12345",
      "payload": { "sender": { "login": "octocat" }, "..." : "..." },
      "occurredAt": "2026-01-15T10:04:55.000Z",
      "receivedAt": "2026-01-15T10:04:56.000Z"
    }
  ]
}
```

Results are ordered by `occurredAt` descending.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/events/payload-search?field=sender.login&value=octocat&moduleId=github"
```
