# Security Architecture

## Authentication mechanisms

Sentinel supports three parallel authentication mechanisms. Only one needs to succeed per request.

### Session authentication

Sessions are stored in the `sessions` table in PostgreSQL. Each session row contains:

| Column | Type | Description |
|---|---|---|
| `sid` | `text` (PK) | 32 random bytes encoded as base64url (`crypto.randomBytes(32).toString('base64url')`). Used as the cookie value. |
| `sess` | `jsonb` | Encrypted session payload: `{ _encrypted: "<base64>" }` |
| `expire` | `timestamptz` | Expiry timestamp. Session max age: 7 days. |

**Encryption** — The `sess` JSONB column stores the encrypted form `{ _encrypted: "<base64>" }` where the value is an AES-256-GCM ciphertext produced by `encrypt()` in `packages/shared/src/crypto.ts`. The plaintext is the JSON-serialized `SessionData`:

```typescript
interface SessionData {
  userId: string;
  orgId: string;
  role: string;   // "admin" | "editor" | "viewer"
}
```

The `ENCRYPTION_KEY` environment variable (64 hex characters, 32 bytes) is the key material for AES-256-GCM encryption of session data. `SESSION_SECRET` is a separate variable used for session-level integrity validation. The cookie itself (`sentinel.sid`) contains only the opaque session ID — no user data is ever placed in the cookie value.

**Cookie attributes:**

| Attribute | Value | Rationale |
|---|---|---|
| `HttpOnly` | `true` | Prevents JavaScript access to the session cookie. |
| `Secure` | `true` in non-development environments | Enforces cookie transmission over HTTPS only. |
| `SameSite` | `Lax` | Blocks cross-site cookie sending for most cases while allowing top-level navigation (for example, OAuth redirects). |
| `MaxAge` | 604800 (7 days) | Matches the server-side expiry. |
| `Path` | `/` | Available to all API paths. |

**Session garbage collection** — The worker runs `platform.session.cleanup` every hour. This job deletes rows from `sessions` where `expire < now()`. Without this, the table would grow indefinitely.

**Backward compatibility** — The `decryptSession()` function handles both the encrypted format (`{ _encrypted: "..." }`) and a legacy plaintext JSONB format (`{ userId, orgId, role }`). This allows a zero-downtime migration from unencrypted to encrypted sessions. Once all legacy sessions have expired, the legacy branch can be removed.

### API key authentication

API keys use a hash-based lookup pattern to avoid storing raw key material:

1. A key is issued as `sk_<random-bytes>`. The full value is shown to the user exactly once and never stored.
2. The server stores `SHA-256(rawKey)` as `api_keys.key_hash` (hex-encoded).
3. On each request, `SHA-256(incomingKey)` is computed and compared to `key_hash` using `crypto.timingSafeEqual()`. This prevents timing side-channel attacks.
4. A `key_prefix` (the first `len('sk_') + 8` characters of the raw key) is stored to support prefix-based lookup without a full table scan.

API key scope values (`api:read`, `api:write`) are stored as a text array in `api_keys.scopes`. Route handlers that require a specific scope can inspect `c.get('scopes')` to enforce fine-grained access.

### Notify key authentication

Infrastructure agents use notify keys to post events to `/modules/infra/ci/notify`. Notify keys are shorter-lived than API keys and are bound to a specific organization. The `notifyKeyMiddleware` validates the key and sets `orgId` on the Hono context. Notify-key authenticated requests are exempt from the CSRF defense header requirement.

## CSRF protection

Sentinel uses the **custom request header** technique for CSRF defense, which is effective against cross-origin form submissions and `fetch()` calls from attacker-controlled pages.

**Mechanism:**

All state-changing requests (POST, PUT, PATCH, DELETE) that carry a `sentinel.sid` session cookie must include the `X-Sentinel-Request` header with any non-empty value. The API returns `403 Forbidden` if the header is absent.

This works as a CSRF defense because:

- Cross-origin `fetch()` calls that include custom headers trigger a CORS preflight (`OPTIONS`). The attacker's origin is not in the API's `ALLOWED_ORIGINS` list, so the browser refuses to send the preflight and the actual request is never made.
- HTML form submissions cannot include custom headers at all.

**Exemptions** — The CSRF check is skipped for:

| Condition | Reason |
|---|---|
| `GET`, `HEAD`, `OPTIONS` methods | Read-only operations do not change server state. |
| Paths containing `/webhooks/`, `/callback`, or `/ci/notify` | Machine-to-machine endpoints that cannot include browser headers. |
| Requests with `Authorization: Bearer ...` header | API key and notify key requests are not vulnerable to CSRF because they require a secret the attacker does not have. |
| Requests without a `sentinel.sid` cookie | Without a session cookie, there is no CSRF attack vector. |

**Frontend implementation** — The `apiFetch`, `apiPost`, `apiPut`, `apiPatch`, and `apiDelete` functions in `apps/web/src/lib/api.ts` include `X-Sentinel-Request: 1` on every request automatically.

## Authorization: RBAC

Sentinel implements role-based access control with three roles:

| Role | Description |
|---|---|
| `admin` | Full access: manage org settings, invite/remove members, manage API keys, configure all integrations, create/modify/delete all resources. |
| `editor` | Create and modify detections, correlation rules, and channels. Cannot manage org membership or API keys. |
| `viewer` | Read-only access to all resources. Cannot create or modify anything. |

Roles are stored in the `org_memberships` table and are included in the session payload and API key context. Route handlers call `requireRole('admin')` or `requireRole('admin', 'editor')` from `apps/api/src/middleware/rbac.ts` to enforce role requirements.

```typescript
// Requires admin or editor role
app.post('/api/detections', requireRole('admin', 'editor'), async (c) => { ... });

// Requires admin role only
app.delete('/api/settings/members/:id', requireRole('admin'), async (c) => { ... });
```

The `requireAuth` and `requireOrg` guards enforce the presence of `userId` and `orgId` respectively, independent of role, and are used on routes that any authenticated org member may access.

## Multi-tenancy isolation

Sentinel is a multi-organization platform. Every table that stores org-specific data carries an `org_id` column. **All application queries filter by `org_id`**. There is no database-level row security policy; isolation is enforced in the application layer.

The `orgId` on the Hono context is the authoritative source. Route handlers must never accept an `org_id` value from the request body or query parameters — they must always use `c.get('orgId')`.

Example pattern in route handlers:

```typescript
app.get('/api/detections', requireAuth, requireOrg, async (c) => {
  const orgId = c.get('orgId');  // From authenticated context — never from request input
  const detections = await db
    .select()
    .from(detectionsTable)
    .where(eq(detectionsTable.orgId, orgId));
  return c.json(detections);
});
```

## Encryption at rest

The `encrypt()` and `decrypt()` functions in `packages/shared/src/crypto.ts` implement AES-256-GCM encryption used throughout the platform for sensitive data at rest.

**Encrypted fields:**

| Table | Column | Content |
|---|---|---|
| `sessions` | `sess` | `{ userId, orgId, role }` |
| `invites` | `invite_secret` | Invite token plaintext |
| `integrations` | `webhook_secret` | Webhook HMAC signing secret |

**Key material** — The `ENCRYPTION_KEY` environment variable must be a 64-character hex string (32 bytes). Generate a new key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Ciphertext format** — Each ciphertext is a base64-encoded string containing:

```
<12-byte nonce> || <ciphertext> || <16-byte GCM authentication tag>
```

A unique random nonce is generated for every encryption operation, so encrypting the same plaintext twice produces different ciphertexts. The GCM authentication tag provides both confidentiality and integrity — any tampering with the ciphertext causes decryption to fail.

## Key rotation

Sentinel supports backward-compatible encryption key rotation via the `ENCRYPTION_KEY_PREV` environment variable.

**Rotation procedure:**

1. Generate a new 32-byte key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Set `ENCRYPTION_KEY_PREV` to the current value of `ENCRYPTION_KEY` in `.env`.
3. Set `ENCRYPTION_KEY` to the new value.
4. Deploy the new configuration. The `decrypt()` function attempts decryption with the current key first, then falls back to the previous key. No downtime is required.
5. The worker runs `platform.key.rotation` every 5 minutes. This job re-encrypts all data that is still encrypted with the old key, using the new key. Once all data has been re-encrypted, `ENCRYPTION_KEY_PREV` can be cleared in the next deployment.

**What the key rotation job does:**

- Scans `sessions.sess` for rows where the JSONB contains `_encrypted` values that decrypt successfully with `ENCRYPTION_KEY_PREV` but fail with `ENCRYPTION_KEY`.
- Re-encrypts those values with the new key and writes them back.
- Performs the same sweep for `integrations.webhook_secret` and `invites.invite_secret`.

## Rate limiting

Rate limiting is implemented in `apps/api/src/middleware/rate-limit.ts` using a Redis-backed sliding window counter.

### Implementation

A Lua script atomically increments a counter key and sets its TTL on first increment, avoiding the race condition where a crash between `INCR` and `EXPIRE` would leave a key without a TTL:

```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
```

The script returns both the current count and TTL in one round-trip, avoiding an extra `redis.ttl()` call.

Counter keys follow the pattern `sentinel:rl:<bucket>:<identity>`.

### Rate limit buckets

| Bucket | Limit | Window | Applied to |
|---|---|---|---|
| `auth` | 10 requests | 15 minutes | `/auth/*` login and registration endpoints |
| `read` | 100 requests | 1 minute | `GET /api/*` |
| `write` | 30 requests | 1 minute | `POST/PUT/PATCH/DELETE /api/*` |

### Identity resolution

The rate limit key identity is resolved in order:

1. **`org:<orgId>`** — if the request is authenticated and `orgId` is set. This is the normal case for dashboard users and API key holders. Limits are shared across all users and keys within the same org.
2. **`key:<prefix>`** — if an API key prefix is present in the `Authorization` header but authentication has not yet resolved an `orgId`. This is a fallback for partially resolved requests.
3. **`ip:<clientIp>`** — for unauthenticated requests (login, register). The client IP is extracted by `getClientIp()` from `packages/shared/src/ip.ts`, which applies `TRUSTED_PROXY_COUNT` rules to correctly derive the real client IP from `X-Forwarded-For` without being vulnerable to header injection from untrusted proxies.

### Response headers

Every response to a rate-limited endpoint includes:

| Header | Value |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

When the limit is exceeded, the server returns `429 Too Many Requests` with message `"Too many requests, please try again later"`.

### Disabling rate limiting

Set `DISABLE_RATE_LIMIT=true` to disable rate limiting globally. This variable is set automatically in the Vitest environment to prevent test failures caused by counter accumulation across test runs.

## Security headers

The following security headers are set on every response by the inline middleware registered after CORS:

| Header | Value | Rationale |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS for 2 years, including subdomains. Applied in production only — sending HSTS in development over HTTP risks permanently breaking HTTP access if the domain is added to browser preload lists. |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing attacks. |
| `X-Frame-Options` | `DENY` | Prevents embedding in `<iframe>`, `<frame>`, or `<object>` elements from any origin. Defends against clickjacking. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Sends the full URL as the `Referer` header for same-origin requests; sends only the origin for cross-origin HTTPS requests; sends nothing for cross-origin HTTP requests. |
| `X-XSS-Protection` | `0` | Disables the legacy IE XSS filter, which can introduce vulnerabilities in modern browsers. Content Security Policy (if added) is the correct defense. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Prevents the page from requesting access to camera, microphone, or geolocation APIs. |
