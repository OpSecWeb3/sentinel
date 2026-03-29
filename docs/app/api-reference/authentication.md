# Authentication

Sentinel supports three authentication mechanisms: session cookies (for browser-based access), API keys (for programmatic access), and notify keys (for webhook ingestion from CI pipelines and external services). Each mechanism suits a different integration pattern.

## Session-based authentication

### Register

Send `POST /auth/register` to create a new user account. The first user to register also creates the organisation and is assigned the `admin` role. Subsequent users must provide an `inviteSecret` to join the existing organisation and are assigned the `viewer` role.

```
POST /auth/register
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string (3-50 chars) | Yes | Username. Alphanumeric, hyphens, and underscores only. Must match `/^[a-zA-Z0-9_-]+$/`. |
| `email` | string | Yes | Valid email address. |
| `password` | string (8-128 chars) | Yes | Account password. |
| `orgName` | string (2-100 chars) | Required for first user | Organisation name. Required when no organisation exists yet. |
| `inviteSecret` | string | Required for subsequent users | Invite secret to join an existing organisation. |

**cURL example (first user -- creates organisation):**

```bash
curl -s -c cookies.txt -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"username": "alice", "email": "alice@example.com", "password": "securepass123", "orgName": "Acme Security"}'
```

**Success response (`201 Created`) -- first user:**

```json
{
  "user": { "id": "usr_01j...", "username": "alice" },
  "org": { "id": "org_01j...", "name": "Acme Security", "slug": "acme-security" },
  "inviteSecret": "raw-secret-shown-once..."
}
```

Store the `inviteSecret` securely. It is only shown at organisation creation time and is needed for subsequent users to join.

**cURL example (joining user):**

```bash
curl -s -c cookies.txt -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"username": "bob", "email": "bob@example.com", "password": "securepass123", "inviteSecret": "raw-secret..."}'
```

**Success response (`201 Created`) -- joining user:**

```json
{
  "user": { "id": "usr_02j...", "username": "bob" },
  "org": { "id": "org_01j...", "name": "Acme Security", "slug": "acme-security" }
}
```

**Failure responses:**

| Status | Body | Cause |
|---|---|---|
| `400` | `{"error": "Invalid input", "details": {...}}` | Validation error |
| `400` | `{"error": "orgName required for first user (creates the organization)"}` | First registration without `orgName` |
| `400` | `{"error": "inviteSecret required to join an existing organization"}` | Joining without invite secret |
| `403` | `{"error": "Invalid invite secret"}` | Wrong invite secret |
| `409` | `{"error": "Registration failed"}` | Username or email already taken |

### Login

Send `POST /auth/login` with a JSON body containing `username` (or email address) and `password`. On success, the server creates a new session, stores it in the database, and sets a `sentinel.sid` cookie.

```
POST /auth/login
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | Yes | Username or email address |
| `password` | string | Yes | Account password |

**cURL example:**

```bash
curl -s -c cookies.txt -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"username": "alice", "password": "securepass123"}'
```

**Success response (`200 OK`):**

```json
{
  "status": "ok",
  "user": {
    "id": "usr_01j...",
    "username": "alice",
    "role": "admin"
  }
}
```

**Failure responses:**

| Status | Body | Cause |
|---|---|---|
| `401 Unauthorized` | `{"error": "Invalid username or password"}` | Wrong credentials. Response timing is equalized via a dummy argon2id comparison to prevent user-enumeration. |
| `423 Locked` | `{"error": "Account temporarily locked. Try again later."}` | Five consecutive failed login attempts trigger a 15-minute lockout |
| `429 Too Many Requests` | `{"error": "Too many requests, please try again later"}` | Login rate limit exceeded (10 attempts per 15 minutes) |

### Session cookie

The `sentinel.sid` cookie is set with the following attributes:

| Attribute | Value |
|---|---|
| `HttpOnly` | `true` -- not accessible to JavaScript |
| `Secure` | `true` in production, `false` in development |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Max-Age` | 604800 seconds (7 days) |

Session data (user ID, org ID, and role) is AES-256-GCM encrypted before storage in the database. The session ID in the cookie is a cryptographically random 32-byte base64url string.

### Session identity

To inspect the currently authenticated identity, call `GET /auth/me`. This endpoint works for both session and API key authentication.

```
GET /auth/me
```

**cURL example (session):**

```bash
curl -s -b cookies.txt http://localhost:4000/auth/me
```

**Session response:**

```json
{
  "user": {
    "userId": "usr_01j...",
    "orgId": "org_01j...",
    "role": "admin"
  },
  "needsOrg": false
}
```

**API key response:**

```json
{
  "apiKey": {
    "keyId": "key_01j...",
    "scopes": ["api:read", "api:write"]
  }
}
```

### Logout

```
POST /auth/logout
```

Deletes the session from the database and clears the `sentinel.sid` cookie.

**cURL example:**

```bash
curl -s -c cookies.txt -b cookies.txt -X POST http://localhost:4000/auth/logout \
  -H "X-Sentinel-Request: 1"
```

**Response (`200 OK`):**

```json
{ "status": "ok" }
```

### Change password

```
POST /auth/change-password
```

Changes the authenticated user's password. Invalidates all other sessions for the user (the current session is preserved). Resets any failed login attempts and account lockout.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `currentPassword` | string | Yes | Current password for verification |
| `newPassword` | string (min 8 chars) | Yes | New password |

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/change-password \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"currentPassword": "old-password", "newPassword": "new-secure-password"}'
```

**Response (`200 OK`):**

```json
{ "status": "ok" }
```

### Session expiry

Sessions expire after 7 days. After expiry, requests that include the stale `sentinel.sid` cookie are treated as unauthenticated. The client receives no automatic session renewal; the user must log in again. The server validates session expiry on every request by comparing the stored `expire` timestamp against the current time.

---

## API key authentication

API keys are long-lived credentials intended for server-to-server integrations, CI pipelines, and scripts. Each key is scoped to a user within an organisation and carries one or more permission scopes.

### Key format

API keys use the prefix `sk_` followed by a random string. The full key is shown once at creation time and is never retrievable again. Only a SHA-256 hash of the key is stored in the database. Lookups use a timing-safe comparison to prevent hash-timing attacks.

**Example key:** `sk_Ax3bY9...` (full key is approximately 54 characters)

### Creating an API key

You can create API keys through the Sentinel UI (Settings > API Keys) or through the API. Creating a key via the API requires an existing authenticated session or an API key with the `api:write` scope.

```
POST /auth/api-keys
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string (1-100 chars) | Yes | Human-readable label for the key |
| `scopes` | string[] | No | Array of permission scopes. Defaults to `["api:read"]`. Valid values: `"api:read"`, `"api:write"` |
| `expiresInDays` | integer (positive) | No | Number of days until the key expires. Omit for a non-expiring key |

**cURL example (session-authenticated):**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"name": "ci-pipeline", "scopes": ["api:read", "api:write"], "expiresInDays": 90}'
```

**Success response (`201 Created`):**

```json
{
  "id": "key_01j...",
  "name": "ci-pipeline",
  "prefix": "sk_Ax3bY9xy",
  "scopes": ["api:read", "api:write"],
  "expiresAt": "2026-06-26T12:00:00.000Z",
  "createdAt": "2026-03-28T12:00:00.000Z",
  "key": "sk_Ax3bY9xy...",
  "warning": "Save this key now. It cannot be retrieved again."
}
```

Store the `key` value securely immediately. It cannot be retrieved after this response.

### Using an API key

Pass the key in the `Authorization` header using the `Bearer` scheme:

```bash
curl -s http://localhost:4000/api/detections \
  -H "Authorization: Bearer sk_Ax3bY9xy..."
```

When using an API key, you do not need the `X-Sentinel-Request` CSRF header.

### Scopes

| Scope | Grants access to |
|---|---|
| `api:read` | All `GET` requests on `/api/*` routes |
| `api:write` | All `POST`, `PUT`, `PATCH`, and `DELETE` requests on `/api/*` routes |

A key must carry the exact scope required by the endpoint. If the key lacks the necessary scope, the server returns `403 Forbidden` with the body `{"error": "Scope \"api:write\" required"}`.

### Key expiry

If a key was created with `expiresInDays`, the server rejects it after the expiry date with `401 Unauthorized` and the message `"API key expired"`. Create a new key before the expiry date to avoid interruption.

### Listing API keys

```
GET /auth/api-keys
```

Returns all API keys for the authenticated user's organisation. The raw key value is never included in list responses.

**cURL example:**

```bash
curl -s http://localhost:4000/auth/api-keys \
  -H "Authorization: Bearer sk_Ax3bY9xy..."
```

**Response (`200 OK`):**

```json
[
  {
    "id": "key_01j...",
    "name": "ci-pipeline",
    "keyPrefix": "sk_Ax3bY9xy",
    "scopes": ["api:read", "api:write"],
    "lastUsedAt": "2026-03-27T15:30:00.000Z",
    "expiresAt": "2026-06-26T12:00:00.000Z",
    "revoked": false,
    "createdAt": "2026-03-28T12:00:00.000Z"
  }
]
```

### Revoking an API key

```
DELETE /auth/api-keys/:id
```

Marks the key as revoked. Revoked keys are rejected immediately on the next request.

**cURL example:**

```bash
curl -s -X DELETE http://localhost:4000/auth/api-keys/key_01j... \
  -H "Authorization: Bearer sk_Ax3bY9xy..."
```

**Response (`200 OK`):**

```json
{ "status": "revoked", "name": "ci-pipeline" }
```

---

## Notify keys

Notify keys are org-level credentials with the prefix `snk_`. They are designed for CI pipelines and external tools that push events into Sentinel via webhook and notify endpoints (for example, `/modules/registry/ci/notify`).

### How notify keys differ from API keys

| Feature | API key (`sk_`) | Notify key (`snk_`) |
|---|---|---|
| Scope | Per-user, per-org | Per-org |
| Intended use | General API access | Webhook/event ingestion only |
| RBAC role | Derived from user membership | None (org-level identity only) |
| Count per org | Multiple | One |
| CSRF bypass | Yes | Yes |
| Session required | No | No |

A notify key sets `notifyKeyOrgId` in the request context. It does not set `userId`, `orgId`, or `role`. Endpoints protected by `requireNotifyKey` accept a valid notify key or a session-authenticated `admin`/`editor` user.

### Checking notify key status

```
GET /auth/org/notify-key/status
```

Returns whether a notify key exists for the organisation, along with its prefix and last-used timestamp.

**Required role:** `admin`

**cURL example:**

```bash
curl -s -b cookies.txt http://localhost:4000/auth/org/notify-key/status
```

**Response (`200 OK`):**

```json
{ "exists": true, "prefix": "snk_Ax3bY9xy", "lastUsedAt": "2026-03-27T12:00:00.000Z" }
```

### Generating a notify key

Notify key management requires the `admin` role. This endpoint rejects the request if a key already exists; use `POST /auth/org/notify-key/rotate` to replace an existing key.

```
POST /auth/org/notify-key/generate
```

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/org/notify-key/generate \
  -H "X-Sentinel-Request: 1"
```

**Response (`201 Created`):**

```json
{
  "key": "snk_...",
  "prefix": "snk_Ax3bY9xy",
  "warning": "Save this key now. It cannot be retrieved again."
}
```

### Using a notify key in CI

```bash
curl -s -X POST https://sentinel.yourdomain.com/modules/registry/ci/notify \
  -H "Authorization: Bearer snk_..." \
  -H "Content-Type: application/json" \
  -d '{"image": "my-org/my-image", "tag": "v1.2.3", "digest": "sha256:abc..."}'
```

### Rotating a notify key

```
POST /auth/org/notify-key/rotate
```

Replaces the existing notify key with a new one. The old key is invalidated immediately.

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/org/notify-key/rotate \
  -H "X-Sentinel-Request: 1"
```

**Response (`201 Created`):**

```json
{
  "key": "snk_...",
  "prefix": "snk_newprefix",
  "warning": "Save this key now. It cannot be retrieved again. The previous key is now invalid."
}
```

### Revoking a notify key

```
DELETE /auth/org/notify-key
```

Deletes the notify key entirely. The org will have no notify key until a new one is generated.

**cURL example:**

```bash
curl -s -b cookies.txt -X DELETE http://localhost:4000/auth/org/notify-key \
  -H "X-Sentinel-Request: 1"
```

**Response (`200 OK`):**

```json
{ "status": "revoked" }
```

---

## Organisation management

### Retrieve invite secret

```
GET /auth/org/invite-secret
```

**Required role:** `admin`

Returns the plaintext invite secret for the organisation. The invite secret is stored encrypted with AES-256-GCM and decrypted at read time.

**cURL example:**

```bash
curl -s -b cookies.txt http://localhost:4000/auth/org/invite-secret
```

**Response (`200 OK`):**

```json
{ "inviteSecret": "raw-secret..." }
```

### Regenerate invite secret

```
POST /auth/org/invite-secret/regenerate
```

**Required role:** `admin`

Generates a new invite secret, invalidating the previous one. Any pending invitations using the old secret will fail.

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/org/invite-secret/regenerate \
  -H "X-Sentinel-Request: 1"
```

**Response (`200 OK`):**

```json
{ "inviteSecret": "new-raw-secret..." }
```

### Join organisation

```
POST /auth/org/join
```

Allows an authenticated user without an organisation to join one by providing the invite secret. The user is assigned the `viewer` role.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `inviteSecret` | string | Yes | The org's invite secret |

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/org/join \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"inviteSecret": "raw-secret..."}'
```

### Leave organisation

```
POST /auth/org/leave
```

Removes the authenticated user from their organisation. Revokes all API keys the user had for the org and invalidates all their sessions. The last admin cannot leave; they must promote another member first.

**cURL example:**

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/org/leave \
  -H "X-Sentinel-Request: 1"
```

### Delete organisation

```
DELETE /auth/org
```

**Required role:** `admin`

Deletes the organisation and all associated data. Invalidates all sessions for all members.

**cURL example:**

```bash
curl -s -b cookies.txt -X DELETE http://localhost:4000/auth/org \
  -H "X-Sentinel-Request: 1"
```

---

## User management (admin only)

### List organisation members

```
GET /auth/users
```

**Required role:** `admin`

**cURL example:**

```bash
curl -s -b cookies.txt http://localhost:4000/auth/users
```

**Response (`200 OK`):**

```json
[
  {
    "id": "usr_01j...",
    "username": "alice",
    "email": "alice@example.com",
    "role": "admin",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

### Change user role

```
PATCH /auth/users/:id/role
```

**Required role:** `admin`

Changes the role of a member. Admins cannot change their own role. The last admin in an org cannot be demoted. All sessions for the target user are invalidated so the new role takes effect immediately.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `role` | `"admin" \| "editor" \| "viewer"` | Yes | New role |

**cURL example:**

```bash
curl -s -b cookies.txt -X PATCH http://localhost:4000/auth/users/usr_02j.../role \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -d '{"role": "editor"}'
```

### Remove member from organisation

```
DELETE /auth/users/:id
```

**Required role:** `admin`

Removes a member from the organisation. Revokes their API keys and invalidates their sessions. Admins cannot remove themselves (use `POST /auth/org/leave` instead).

**cURL example:**

```bash
curl -s -b cookies.txt -X DELETE http://localhost:4000/auth/users/usr_02j... \
  -H "X-Sentinel-Request: 1"
```

---

## Setup status

```
GET /auth/setup-status
```

Public endpoint (no authentication required). Returns whether the system needs initial setup (no organisations exist yet). Used by the web dashboard to show the registration form on first launch.

**cURL example:**

```bash
curl -s http://localhost:4000/auth/setup-status
```

**Response (`200 OK`):**

```json
{ "needsSetup": true }
```

---

## CSRF protection

State-changing requests authenticated with a session cookie require the `X-Sentinel-Request` header with any non-empty value. This header defends against cross-site request forgery (CSRF) attacks in which a malicious third-party site sends requests on behalf of a logged-in user.

### When the header is required

The header is required when **all** of the following conditions are true:

1. The request method is `POST`, `PUT`, `PATCH`, or `DELETE`.
2. The request carries the `sentinel.sid` session cookie.
3. The request path does not match a webhook or callback path (containing `/webhooks/`, `/callback`, or `/ci/notify`).

### When the header is not required

- `GET`, `HEAD`, and `OPTIONS` requests never require the header.
- Requests authenticated with a `Bearer` token (API key or notify key) skip the CSRF check entirely.
- Requests to webhook and OAuth callback paths (containing `/webhooks/`, `/callback`, or `/ci/notify`) skip the check.
- Requests without a `sentinel.sid` cookie skip the check (no CSRF attack vector).

### What happens if the header is missing

The server returns:

```
HTTP/1.1 403 Forbidden
Content-Type: application/json

{"error": "Missing CSRF defense header: X-Sentinel-Request"}
```

### Adding the header in cURL

Include `-H "X-Sentinel-Request: 1"` on any state-changing cURL request that uses a session cookie:

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/auth/logout \
  -H "X-Sentinel-Request: 1"
```

---

## Authentication middleware chain

Every request passes through the following middleware stack in order:

1. **`sessionMiddleware`** -- Reads the `sentinel.sid` cookie, looks up the session in the database, decrypts session data, and sets `userId`, `orgId`, and `role` in the request context.
2. **`apiKeyMiddleware`** -- If the `Authorization` header starts with `Bearer sk_`, validates the API key hash, checks expiry and revocation, verifies the user still has org membership, and sets `userId`, `orgId`, `apiKeyId`, `scopes`, and `role`.
3. **`notifyKeyMiddleware`** -- If the `Authorization` header starts with `Bearer snk_`, validates the notify key hash via timing-safe comparison and sets `notifyKeyOrgId`.

These three middleware functions run on every request. They do not reject unauthenticated requests; they only populate the request context. Route-level guards (`requireAuth`, `requireOrg`, `requireRole`, `requireScope`, `requireNotifyKey`) enforce access requirements.

---

## Role-based access control (RBAC)

Every user belongs to an organisation with one of three roles: `admin`, `editor`, or `viewer`. The role is stored in `org_memberships` and is included in the encrypted session data and resolved on every API key request.

### Role capabilities

| Capability | admin | editor | viewer |
|---|---|---|---|
| Read all resources | Yes | Yes | Yes |
| Create detections and correlation rules | Yes | Yes | No |
| Update detections and correlation rules | Yes | Yes | No |
| Create and update channels | Yes | Yes | No |
| Delete detections, channels, correlation rules | Yes | No | No |
| Manage API keys (create/revoke) | Yes | Yes | No |
| Manage notify key | Yes | No | No |
| Invite management (view/regenerate invite secret) | Yes | No | No |
| Manage org (delete, manage roles, remove members) | Yes | No | No |

### Role enforcement

Routes use `requireRole('admin')` or `requireRole('admin', 'editor')` middleware. If the authenticated user lacks the required role, the server returns `403 Forbidden` with `{"error": "Insufficient permissions"}`.

---

## Common authentication errors

| Status | Message | Cause |
|---|---|---|
| `401 Unauthorized` | `"Authentication required"` | No session cookie and no `Authorization` header on a protected route |
| `401 Unauthorized` | `"Invalid API key"` | Key not found, revoked, hash mismatch, or user no longer a member of the org |
| `401 Unauthorized` | `"API key expired"` | Key was created with an expiry date that has passed |
| `401 Unauthorized` | `"Invalid notify key"` | Notify key not found or hash mismatch |
| `401 Unauthorized` | `"Invalid username or password"` | Login failed (wrong credentials) |
| `403 Forbidden` | `"Organisation membership required"` | Authenticated user exists but is not a member of any organisation |
| `403 Forbidden` | `"Missing CSRF defense header: X-Sentinel-Request"` | State-changing request via session cookie without the CSRF header |
| `403 Forbidden` | `"Insufficient permissions"` | Correct authentication but insufficient RBAC role |
| `403 Forbidden` | `"Scope \"api:write\" required"` | API key lacks the required scope |
| `403 Forbidden` | `"Valid notify key required"` | Endpoint requires a notify key; neither a valid `snk_` key nor an `admin`/`editor` session was provided |
| `423 Locked` | `"Account temporarily locked. Try again later."` | Account locked after five consecutive failed login attempts (15-minute lockout) |
