# Sentinel REST API

Sentinel exposes a JSON REST API for programmatic access to all platform resources: detections, alerts, events, audit logs, correlation rules, channels, integrations, and module-specific analytics. The API runs on [Hono 4.7](https://hono.dev/) on Node.js 22 and is the same API the Sentinel web dashboard uses internally.

## Base URL

| Environment | Base URL |
|---|---|
| Development | `http://localhost:4000` |
| Production | `https://sentinel.yourdomain.com` |

In production, the API process listens on the port specified by the `PORT` environment variable and is served through nginx, which terminates TLS and proxies requests. All production traffic must use HTTPS; the server sends an HSTS header (`max-age=63072000; includeSubDomains; preload`) on every response in production.

## Authentication methods

The API supports two primary authentication methods and one specialized key type for webhook ingestion.

| Method | How to pass | When to use |
|---|---|---|
| Session cookie | Automatic (browser sets `sentinel.sid` cookie after login) | Interactive browser sessions and the Sentinel web dashboard |
| API key | `Authorization: Bearer sk_<key>` header | Server-to-server integrations, CI pipelines, scripts |
| Notify key | `Authorization: Bearer snk_<key>` header | CI pipelines and external integrations pushing events into Sentinel via webhook endpoints |

See [authentication.md](./authentication.md) for the full authentication reference, including CSRF requirements, RBAC roles, and scopes.

## Required headers

| Header | Required for | Value |
|---|---|---|
| `Content-Type` | All requests with a body | `application/json` |
| `Authorization` | API key and notify key requests | `Bearer <key>` |
| `X-Sentinel-Request` | State-changing requests authenticated with a session cookie (POST, PUT, PATCH, DELETE) | Any non-empty value (e.g. `1`) |

The `X-Sentinel-Request` header is a CSRF defense token. The Sentinel web frontend adds this header automatically on every fetch. When you use an API key or notify key (`Bearer` token), the header is not required. See [authentication.md -- CSRF protection](./authentication.md#csrf-protection) for details.

## Response format

All responses are JSON. Successful responses use one of the following shapes depending on the endpoint.

**Single-resource response (wrapped in `data`):**

```json
{
  "data": {
    "id": "d1e2f3a4-...",
    "name": "My Detection",
    "createdAt": "2026-03-28T12:00:00.000Z"
  }
}
```

**Paginated list response:**

```json
{
  "data": [
    { "id": "abc123", "name": "My Detection" },
    { "id": "def456", "name": "Another Detection" }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

**Status response (auth endpoints):**

```json
{
  "status": "ok",
  "user": { "id": "usr_01j...", "username": "alice", "role": "admin" }
}
```

**Error response:**

```json
{
  "error": "Authentication required"
}
```

Validation errors include a `details` field:

```json
{
  "error": "Validation failed",
  "details": [
    { "path": "name", "message": "String must contain at least 1 character(s)" }
  ]
}
```

See [error-handling.md](./error-handling.md) for the complete error reference.

## Pagination

Paginated endpoints accept `page` (default `1`) and `limit` (default `20`, max `100`) query parameters. The response includes a `meta` object with `page`, `limit`, `total`, and `totalPages` fields.

Some list endpoints use offset-based pagination with `limit` and `offset` parameters (for example, `GET /api/channels`). Check the individual endpoint reference for which pagination style applies.

Not all list endpoints are paginated; some return the full collection. Check the individual endpoint reference for pagination support.

## Security headers

Every response includes the following security headers:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-XSS-Protection` | `0` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

In production, responses also include `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

## API versioning

The API does not use a version prefix in the URL path (for example, there is no `/v1/` segment). Breaking changes are communicated through the Sentinel changelog. If you pin integrations against this API, review the changelog before upgrading the Sentinel server.

## Health check

```
GET /health
```

Returns `200 OK` with service status when the database and Redis are reachable. Returns `503 Service Unavailable` with a `"status": "degraded"` body when either dependency is unavailable. This endpoint does not require authentication.

**Response:**

```json
{
  "status": "ok",
  "db": "ok",
  "redis": "ok",
  "timestamp": "2026-03-28T12:00:00.000Z"
}
```

**cURL example:**

```bash
curl -s http://localhost:4000/health
```

## Endpoint groups

| Group | Path prefix | Documentation |
|---|---|---|
| Authentication | `/auth` | [authentication.md](./authentication.md) |
| Detections | `/api/detections` | [detections.md](./detections.md) |
| Alerts | `/api/alerts` | [alerts.md](./alerts.md) |
| Channels | `/api/channels` | [channels.md](./channels.md) |
| Correlation rules | `/api/correlation-rules` | [correlation-rules.md](./correlation-rules.md) |
| Events | `/api/events` | [events.md](./events.md) |
| Notification deliveries | `/api/notification-deliveries` | [notification-deliveries.md](./notification-deliveries.md) |
| Modules and analytics | `/api/modules`, `/api/chain`, `/api/github`, `/api/registry`, `/api/infra`, `/api/aws` | [modules.md](./modules.md) |
| Integrations | `/integrations` | [authentication.md](./authentication.md) (Slack OAuth section) |
| Rate limiting | All `/api/*` routes | [rate-limiting.md](./rate-limiting.md) |
| Error handling | All routes | [error-handling.md](./error-handling.md) |

## Quick start

### Step 1: Log in and obtain a session

```bash
curl -s -c cookies.txt -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"username": "your-username", "password": "your-password"}'
```

### Step 2: Create an API key

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"name": "my-integration", "scopes": ["api:read", "api:write"]}'
```

Save the `key` value from the response. It is shown exactly once and cannot be retrieved again.

### Step 3: Make an authenticated API request

```bash
curl -s http://localhost:4000/api/detections \
  -H "Authorization: Bearer sk_<your-key>"
```

Replace `http://localhost:4000` with your production base URL when deploying.
