# Error handling

All error responses from the Sentinel API use a consistent JSON body. Understanding error shapes and status codes lets you build resilient integrations that handle failures gracefully.

## Error response shape

Every error response body contains an `error` field. Some responses also include a `details` array for structured validation errors.

**Standard error:**

```json
{
  "error": "Authentication required"
}
```

**Validation error (from the `validate` middleware or `safeParse` in route handlers):**

```json
{
  "error": "Validation failed",
  "details": [
    { "path": "name", "message": "String must contain at least 1 character(s)" },
    { "path": "scopes.0", "message": "Invalid enum value. Expected 'api:read' | 'api:write'" }
  ]
}
```

Some route handlers use `safeParse` directly and return a slightly different shape using Zod's `flatten()` output:

```json
{
  "error": "Invalid input",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "username": ["String must contain at least 3 character(s)"],
      "email": ["Invalid email"]
    }
  }
}
```

The `details` field structure depends on which validation path was used. Both shapes are described in the sections below.

---

## HTTP status codes

| Status | Meaning | When Sentinel uses it |
|---|---|---|
| `200 OK` | Success | Successful `GET`, `POST /auth/login`, `POST /auth/logout` |
| `201 Created` | Resource created | Successful resource creation (`POST`) |
| `204 No Content` | Success, no body | Some delete operations |
| `400 Bad Request` | Client error | Invalid JSON, failed Zod validation, missing required fields, business logic rejections |
| `401 Unauthorized` | Authentication failure | No credentials, invalid or expired API key, wrong password |
| `403 Forbidden` | Authorization failure | Insufficient RBAC role, missing CSRF header, missing scope, invalid notify key |
| `404 Not Found` | Resource not found | Route does not exist or specific resource ID not found |
| `409 Conflict` | State conflict | Duplicate resource (for example, username or email already taken) |
| `422 Unprocessable Entity` | Semantic error | Not used by default; reserved for future use |
| `423 Locked` | Account locked | Login attempted on a temporarily locked account |
| `429 Too Many Requests` | Rate limit exceeded | Read or write rate limit exceeded |
| `501 Not Implemented` | Feature not configured | Slack integration not configured on this server |
| `502 Bad Gateway` | Upstream failure | Channel test notification delivery failed (Slack, webhook, or email) |
| `500 Internal Server Error` | Server error | Unhandled exception; see [server errors](#server-errors) |
| `503 Service Unavailable` | Dependency unavailable | Returned by `GET /health` when the database or Redis is unreachable |

---

## Validation errors (400)

Validation errors occur when the request body, query parameters, or path parameters fail Zod schema validation.

### `validate` middleware format

Routes using the `validate(target, schema)` middleware return:

```json
{
  "error": "Validation failed",
  "details": [
    { "path": "name", "message": "Required" },
    { "path": "scopes.0", "message": "Invalid enum value. Expected 'api:read' | 'api:write'" }
  ]
}
```

Each `details` entry has:

| Field | Type | Description |
|---|---|---|
| `path` | string | Dot-notation path to the invalid field (for example, `"scopes.0"`) |
| `message` | string | Human-readable Zod validation message |

### `safeParse` + `flatten()` format

Some routes (for example, `/auth/register` and `/auth/api-keys`) call `safeParse` directly and use Zod's `flatten()` method:

```json
{
  "error": "Invalid input",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "username": ["String must contain at least 3 character(s)", "Invalid"],
      "password": ["String must contain at least 8 character(s)"]
    }
  }
}
```

### Invalid JSON body

If the request body is not valid JSON:

```json
{ "error": "Invalid JSON body" }
```

### Other 400 scenarios

| Message | Cause |
|---|---|
| `"orgName required for first user (creates the organization)"` | First registration without providing `orgName` |
| `"inviteSecret required to join an existing organization"` | Registration after org creation without providing `inviteSecret` |
| `"Invalid organisation name"` | `orgName` produces an empty slug after normalization |
| `"You already belong to an organisation. Leave it first."` | Calling `POST /auth/org/join` when already a member |
| `"Cannot change your own role"` | Admin attempting `PATCH /auth/users/:id/role` on their own ID |
| `"Cannot remove yourself. Use /org/leave instead."` | Admin attempting `DELETE /auth/users/:id` on their own ID |

---

## Authentication errors (401)

A `401 Unauthorized` response means that the request could not be authenticated.

| Message | Cause |
|---|---|
| `"Authentication required"` | Protected route accessed with no session cookie and no `Authorization` header |
| `"Invalid API key"` | `Bearer sk_...` key not found in database, already revoked, hash mismatch, or the issuing user is no longer a member of the org |
| `"API key expired"` | Key was created with an `expiresInDays` value and the expiry date has passed |
| `"Invalid username or password"` | Login failed; response timing is equalized via a dummy argon2id comparison to prevent user-enumeration via timing |
| `"Current password is incorrect"` | `POST /auth/change-password` called with wrong `currentPassword` |

**Example 401 response:**

```bash
curl -s http://localhost:4000/api/detections
```

```json
{ "error": "Authentication required" }
```

---

## Authorization errors (403)

A `403 Forbidden` response means the request was authenticated but not authorized.

| Message | Cause |
|---|---|
| `"Organisation membership required"` | Authenticated user is not a member of any organisation |
| `"Missing CSRF defense header: X-Sentinel-Request"` | State-changing request via session cookie without the `X-Sentinel-Request` header |
| `"Insufficient permissions"` | User's RBAC role does not satisfy the route's `requireRole(...)` constraint |
| `"Scope \"api:read\" required"` | API key lacks the `api:read` scope |
| `"Scope \"api:write\" required"` | API key lacks the `api:write` scope |
| `"Valid notify key required"` | Endpoint requires a notify key; the request carried neither a valid `snk_` key nor an `admin`/`editor` session |
| `"Invalid invite secret"` | Registration or join attempted with an incorrect invite secret |

**Example 403 response (missing CSRF header):**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/api/detections \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}'
```

```json
{ "error": "Missing CSRF defense header: X-Sentinel-Request" }
```

---

## Not found errors (404)

A `404 Not Found` response is returned when:

- The requested route path does not exist. The global not-found handler returns `{"error": "Not found"}`.
- A specific resource ID does not exist in the database (for example, `DELETE /auth/api-keys/nonexistent`). Route-level 404s use context-specific messages such as `{"error": "API key not found"}` or `{"error": "Member not found"}`.

---

## Conflict errors (409)

A `409 Conflict` response is returned when a resource already exists and the operation would create a duplicate.

| Endpoint | Condition | Message |
|---|---|---|
| `POST /auth/register` | Username or email already taken | `"Registration failed"` |
| `POST /auth/org/notify-key/generate` | A notify key already exists for the org | `"Notify key already exists. Use rotate to replace it."` |

---

## Rate limit errors (429)

```json
{ "error": "Too many requests, please try again later" }
```

When the rate limit is exceeded, the response also includes:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Always `0` when a 429 is returned |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |

Use the `X-RateLimit-Reset` value to determine when to retry. See [rate-limiting.md](./rate-limiting.md) for implementation details and retry strategies.

---

## Upstream errors (502)

A `502 Bad Gateway` response indicates that an upstream service call failed. Currently this only occurs on the `POST /api/channels/:id/test` endpoint when the test notification delivery fails (for example, a webhook URL returns an error, Slack API is unreachable, or SMTP connection is refused).

```json
{ "error": "Test notification failed. Check channel configuration and try again." }
```

---

## Service unavailable (503)

A `503 Service Unavailable` response occurs in two situations:

1. **Health check failure:** `GET /health` returns `503` when the database or Redis is unreachable.
2. **Module registry not initialised:** `GET /api/modules/metadata` returns `503` if the module registry was not set up at server startup.
3. **Redis operation failure:** Correlation rule instance endpoints return `503` if the Redis SCAN or pipeline operation fails.

---

## Server errors (500)

Unhandled exceptions return:

```json
{ "error": "Internal server error" }
```

The server logs the full error (stack trace, request ID) using the structured `pino` logger at the `error` level and reports the exception to Sentry. The client response never includes stack traces or internal details.

If you receive a persistent `500` from a specific endpoint, check the API server logs. Each request carries a unique `requestId` (set by the `request-context` middleware); include this ID when reporting issues.

**What is logged (server-side only):**

- Full stack trace
- Request ID
- Request method and path
- Any structured context attached to the logger

**What is returned to the client:**

- Only `{"error": "Internal server error"}` with HTTP status `500`
