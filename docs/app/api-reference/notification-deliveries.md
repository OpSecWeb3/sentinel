# Notification Deliveries API

Notification deliveries are the audit trail for alert notifications. Each delivery record tracks a single attempt to deliver an alert through a specific channel (email, webhook, or Slack). Deliveries are created by the worker alert-dispatch pipeline and are read-only from the API.

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header, and active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |

---

## Delivery object

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string (numeric)` | Auto-incrementing delivery ID (backed by a `bigserial` column). Passed as a string. |
| `alertId` | `string (numeric)` | Alert that triggered this delivery. |
| `channelId` | `string (UUID) \| null` | Notification channel used for delivery. |
| `channelType` | `"email" \| "slack" \| "webhook" \| "pagerduty"` | Type of channel used. |
| `status` | `"pending" \| "sent" \| "failed"` | Delivery status. |
| `statusCode` | `integer \| null` | HTTP status code returned by the target (webhook deliveries). |
| `responseTimeMs` | `integer \| null` | Response time in milliseconds. |
| `error` | `string \| null` | Error message if the delivery failed. |
| `attemptCount` | `integer` | Number of delivery attempts made. |
| `sentAt` | `string (ISO 8601) \| null` | Timestamp when the delivery was successfully sent. |
| `createdAt` | `string (ISO 8601)` | Timestamp when the delivery record was created. |

---

## Endpoints

### List notification deliveries

```
GET /api/notification-deliveries
```

Returns a paginated, filtered list of notification deliveries for the authenticated organisation. Deliveries are scoped to the organisation via the alerts table (deliveries do not store `orgId` directly).

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `alertId` | `string (numeric)` | No | Filter by alert ID. |
| `channelId` | `string` | No | Filter by channel ID. |
| `channelType` | `"email" \| "slack" \| "webhook" \| "pagerduty"` | No | Filter by channel type. |
| `status` | `"pending" \| "sent" \| "failed"` | No | Filter by delivery status. |
| `from` | `string (ISO 8601 datetime)` | No | Return deliveries created at or after this time. |
| `to` | `string (ISO 8601 datetime)` | No | Return deliveries created at or before this time. |
| `page` | `integer (>=1)` | No | Page number. Default: `1`. |
| `limit` | `integer (1-100)` | No | Results per page. Default: `20`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "456",
      "alertId": "1234",
      "channelId": "chan-uuid-...",
      "channelType": "slack",
      "status": "sent",
      "statusCode": null,
      "responseTimeMs": 230,
      "error": null,
      "attemptCount": 1,
      "sentAt": "2026-01-15T10:05:01.000Z",
      "createdAt": "2026-01-15T10:05:00.000Z",
      "alertTitle": "Public Repository Created"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 89,
    "totalPages": 5
  }
}
```

The list response includes an `alertTitle` field resolved via a subquery.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/notification-deliveries?status=failed&channelType=webhook&limit=50"
```

---

### Get delivery detail

```
GET /api/notification-deliveries/:id
```

Returns a single delivery record.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string (numeric)` | Delivery ID. Must be a string of digits. |

**Response `200 OK`**

```json
{
  "data": {
    "id": "456",
    "alertId": "1234",
    "channelId": "chan-uuid-...",
    "channelType": "webhook",
    "status": "failed",
    "statusCode": 502,
    "responseTimeMs": 5012,
    "error": "Upstream server returned 502",
    "attemptCount": 3,
    "sentAt": null,
    "createdAt": "2026-01-15T10:05:00.000Z"
  }
}
```

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Delivery found and returned. |
| `400` | `id` is not a numeric string. |
| `404` | Delivery not found or belongs to a different organisation. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/notification-deliveries/456"
```

---

### Delivery stats

```
GET /api/notification-deliveries/stats
```

Returns aggregate statistics for notification deliveries across the organisation. This endpoint does not accept query parameters.

**Response `200 OK`**

```json
{
  "total": 1245,
  "thisWeek": 87,
  "byStatus": {
    "sent": 1100,
    "failed": 120,
    "pending": 25
  },
  "byChannelType": {
    "slack": 600,
    "email": 400,
    "webhook": 245
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `total` | `integer` | Total number of delivery records. |
| `thisWeek` | `integer` | Deliveries created in the last 7 days. |
| `byStatus` | `object` | Delivery count keyed by status. Statuses with zero deliveries may be absent. |
| `byChannelType` | `object` | Delivery count keyed by channel type. Types with zero deliveries may be absent. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/notification-deliveries/stats"
```
