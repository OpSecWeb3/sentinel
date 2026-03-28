# Channels API

Notification channels define where Sentinel delivers alerts when a detection or correlation rule fires. Sentinel supports three channel types: `email`, `webhook`, and `slack`. Channels are created at the organisation level and associated with individual detections and correlation rules by including the channel UUID in the resource's `channelIds` array.

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header, and active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |
| `POST`, `PATCH` | editor, admin | `api:write` |
| `DELETE` | admin | `api:write` |

---

## Channel object

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (UUID)` | Unique channel identifier. |
| `orgId` | `string (UUID)` | Organisation that owns this channel. |
| `name` | `string` | Human-readable display name. |
| `type` | `"email" \| "webhook" \| "slack"` | Channel delivery type. |
| `config` | `object` | Type-specific configuration. See [Channel config](#channel-config). |
| `enabled` | `boolean` | Whether the channel is active. Disabled channels do not receive deliveries. |
| `isVerified` | `boolean` | Whether the channel has been verified (currently informational; set by webhook delivery success). |
| `deletedAt` | `string (ISO 8601) \| null` | Soft-delete timestamp. Non-null means the channel is deleted and invisible from list/get responses. |
| `createdAt` | `string (ISO 8601)` | Creation timestamp. |
| `updatedAt` | `string (ISO 8601)` | Last-updated timestamp. |

### Channel config

The `config` field structure differs by channel type.

#### Email config

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recipients` | `string[]` | Yes | Array of one or more valid email addresses. |

```json
{
  "recipients": ["security@example.com", "oncall@example.com"]
}
```

Email channels require `SMTP_URL` to be configured in the server environment. If `SMTP_URL` is not set, attempts to create or test an email channel will return a `400` error.

#### Slack config

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channelId` | `string` | Yes | Slack channel ID (e.g., `C01234ABCDE`). |

```json
{
  "channelId": "C01234ABCDE"
}
```

Slack channels require a connected Slack integration (via OAuth at `GET /integrations/slack/install`). The `SLACK_BOT_TOKEN` must be available in the environment for test notifications. The bot must be invited to the target Slack channel.

#### Webhook config

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string (URL)` | Yes | Target URL for HTTP POST delivery. |
| `secret` | `string` | No | HMAC-SHA256 signing secret. See [Webhook security](#webhook-security). When returned by the API, this field is always redacted as `"***"`. |
| `headers` | `object` | No | Custom HTTP headers to include in delivery requests. Key-value string pairs. Maximum 256 characters per key name, 4096 per value. |

```json
{
  "url": "https://hooks.example.com/sentinel",
  "secret": "***",
  "headers": {
    "X-Custom-Header": "my-value"
  }
}
```

### Webhook security

Sentinel automatically generates a 64-character hex signing secret when you create a webhook channel without providing one. The generated secret is returned **once** in the `generatedSecret` field of the creation response and is never returned again. Store it securely.

For each delivery, Sentinel computes an `X-Signature: sha256=<hex>` header over the JSON request body using HMAC-SHA256 with the stored secret. Your endpoint should verify this signature.

The following request headers cannot be set in the `headers` map and are silently stripped if provided: `host`, `transfer-encoding`, `connection`, `content-length`, `cookie`, `authorization`, `x-signature`, `content-type`.

### Associating channels with detections

After creating a channel, include its `id` in the `channelIds` array when creating or updating a detection or correlation rule:

```json
{
  "channelIds": ["chan-uuid-1", "chan-uuid-2"]
}
```

When the detection fires, the dispatcher sends a notification to every enabled channel in `channelIds`.

---

## Endpoints

### List channels

```
GET /api/channels
```

Returns all non-deleted channels for the authenticated organisation.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"email" \| "webhook" \| "slack"` | No | Filter by channel type. |
| `limit` | `integer (1–100)` | No | Maximum results to return. Default: `50`. |
| `offset` | `integer (≥0)` | No | Number of results to skip (offset-based pagination). Default: `0`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "chan-uuid-...",
      "orgId": "org-uuid-...",
      "name": "Security Team Email",
      "type": "email",
      "config": { "recipients": ["security@example.com"] },
      "enabled": true,
      "isVerified": false,
      "deletedAt": null,
      "createdAt": "2026-01-10T09:00:00.000Z",
      "updatedAt": "2026-01-10T09:00:00.000Z"
    }
  ],
  "limit": 50,
  "offset": 0
}
```

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/channels?type=email"
```

---

### Get channel

```
GET /api/channels/:id
```

Returns a single non-deleted channel.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Channel ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "chan-uuid-...",
    "orgId": "org-uuid-...",
    "name": "Incident Webhook",
    "type": "webhook",
    "config": {
      "url": "https://hooks.example.com/sentinel",
      "secret": "***",
      "headers": { "X-Source": "sentinel" }
    },
    "enabled": true,
    "isVerified": true,
    "deletedAt": null,
    "createdAt": "2026-01-10T09:00:00.000Z",
    "updatedAt": "2026-01-12T14:30:00.000Z"
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Channel found and returned. |
| `404` | Channel not found, deleted, or belongs to a different organisation. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/channels/chan-uuid-..."
```

---

### Create channel

```
POST /api/channels
```

Creates a new notification channel.

**Required role:** `admin` or `editor`

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string (1–255)` | Yes | Display name. |
| `type` | `"email" \| "webhook" \| "slack"` | Yes | Channel type. |
| `config` | `object` | Yes | Type-specific config. See [Channel config](#channel-config). |

**Response `201 Created`**

For webhook channels, if a `secret` was not provided in `config.secret`, the response includes a top-level `generatedSecret` field. This is the only time the plaintext secret is returned.

```json
{
  "data": {
    "id": "chan-uuid-...",
    "orgId": "org-uuid-...",
    "name": "Incident Webhook",
    "type": "webhook",
    "config": {
      "url": "https://hooks.example.com/sentinel",
      "secret": "***"
    },
    "enabled": true,
    "isVerified": false,
    "deletedAt": null,
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-01-15T10:00:00.000Z"
  },
  "generatedSecret": "a1b2c3d4e5f6..."
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `201` | Channel created. |
| `400` | Validation error or SMTP not configured for email channels. |

**cURL example — create an email channel**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Security Team Email",
    "type": "email",
    "config": {
      "recipients": ["security@example.com", "oncall@example.com"]
    }
  }' \
  "http://localhost:4000/api/channels"
```

**cURL example — create a webhook channel**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Incident Webhook",
    "type": "webhook",
    "config": {
      "url": "https://hooks.example.com/sentinel",
      "headers": { "X-Source": "sentinel" }
    }
  }' \
  "http://localhost:4000/api/channels"
```

---

### Update channel

```
PATCH /api/channels/:id
```

Performs a partial update on a channel. At least one of `name`, `config`, or `enabled` must be provided. When updating a webhook channel's `config`, the full type-specific validation is re-applied.

**Required role:** `admin` or `editor`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Channel ID. |

**Request body** (all fields optional; at least one required)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string (1–255)` | New display name. |
| `config` | `object` | Replace channel config. Validated against the channel's existing type. For webhook channels, a new `secret` value is encrypted before storage. |
| `enabled` | `boolean` | Enable or disable the channel. |

**Response `200 OK`**

```json
{
  "data": { /* updated channel object */ }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Channel updated. |
| `400` | Validation error or no fields provided. |
| `404` | Channel not found or deleted. |

**cURL example — disable a channel**

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer sk_..." \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }' \
  "http://localhost:4000/api/channels/chan-uuid-..."
```

---

### Delete channel

```
DELETE /api/channels/:id
```

Soft-deletes a channel by setting `deletedAt`. The channel no longer appears in list or get responses. Existing `channelIds` references in detections and correlation rules are not automatically removed; they will be silently skipped during dispatch.

**Required role:** `admin`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Channel ID. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "chan-uuid-...",
    "deleted": true
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Channel soft-deleted. |
| `404` | Channel not found or already deleted. |

**cURL example**

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/channels/chan-uuid-..."
```

---

### Test channel

```
POST /api/channels/:id/test
```

Sends a test notification through the specified channel. The test message does not create an alert record. If delivery fails, the endpoint returns `502` with an error message; the channel configuration should be verified before retrying.

**Required role:** `admin` or `editor`

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (UUID)` | Channel ID. |

The test payload sent to all channel types is:

```json
{
  "title": "Test Notification from Sentinel",
  "severity": "medium",
  "description": "This is a test notification to verify your channel configuration.",
  "module": "platform",
  "eventType": "test",
  "timestamp": "<current ISO 8601 timestamp>"
}
```

**Response `200 OK`**

```json
{
  "data": {
    "id": "chan-uuid-...",
    "testSent": true
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Test notification sent successfully. |
| `400` | Channel is disabled, SMTP not configured, or channel type does not support testing. |
| `404` | Channel not found. |
| `502` | Delivery attempt failed (network error, bad credentials, etc.). |

**cURL example**

```bash
curl -s -X POST \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/channels/chan-uuid-.../test"
```
