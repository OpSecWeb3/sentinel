# Rate limiting

Sentinel enforces rate limits on all `/api/*` routes and authentication endpoints to protect the service from abuse and ensure fair resource allocation across users and organisations.

## Implementation

Rate limiting uses a Redis-backed sliding counter implemented with a Lua script. The Lua script atomically increments the request counter and sets the key expiry in a single operation, which prevents a race condition where a crash between `INCR` and `EXPIRE` could leave a counter key without a TTL.

The counter key is prefixed `sentinel:rl:<bucket>:<identity>`.

## Rate limit key hierarchy

The identity used for rate limiting follows this priority order:

1. **Organisation ID** (`org:<orgId>`) — used when the request is authenticated and has an org context. This applies to both session-authenticated and API key-authenticated requests.
2. **API key prefix** (`key:<prefix>`) — used for API key requests when no org context is available (uncommon).
3. **Client IP address** (`ip:<address>`) — fallback for unauthenticated requests (for example, `POST /auth/login`).

IP address derivation applies `TRUSTED_PROXY_COUNT` rules to avoid header-injection spoofing when the API is behind a reverse proxy. Set `TRUSTED_PROXY_COUNT` in the environment to the number of trusted proxy hops in your deployment.

## Rate limit buckets

Sentinel uses separate buckets for read and write operations, with different limits and a shared window duration.

| Bucket | Applies to | Limit | Window |
|---|---|---|---|
| `read` | `GET` requests on `/api/*` | 100 requests | 60 seconds |
| `write` | `POST`, `PUT`, `PATCH`, `DELETE` requests on `/api/*` | 30 requests | 60 seconds |
| `auth` | `POST /auth/login`, `POST /auth/register`, `POST /auth/change-password` | 10 requests | 15 minutes (900 seconds) |

The read and write buckets operate independently. Exhausting your write quota does not affect your read quota, and vice versa.

In addition to the `/api/*` route limiter, the auth router applies the write limiter (30/min) as a baseline to all `/auth/*` routes. Read-oriented auth endpoints (`GET /auth/me`, `GET /auth/api-keys`, `GET /auth/org/invite-secret`, `GET /auth/org/notify-key/status`, `GET /auth/users`, `GET /auth/setup-status`) override this with the more permissive read limiter (100/min). Login, register, and change-password also apply the stricter auth limiter (10/15min) on top of the baseline.

## Rate limit headers

Every response from a rate-limited route includes the following headers, regardless of whether the limit has been reached:

| Header | Type | Description |
|---|---|---|
| `X-RateLimit-Limit` | integer | Maximum number of requests allowed in the current window |
| `X-RateLimit-Remaining` | integer | Number of requests remaining in the current window. Always `0` or greater |
| `X-RateLimit-Reset` | integer | Unix timestamp (seconds since epoch) when the current window resets and the counter returns to the full limit |

These headers are also exposed via CORS (`Access-Control-Expose-Headers`) so browser-based clients can read them.

**Example headers on a successful response:**

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1743166860
```

## 429 response

When the request count exceeds the limit, the server returns:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1743166860
```

```json
{ "error": "Too many requests, please try again later" }
```

Note: The API does not send a `Retry-After` header. Use the `X-RateLimit-Reset` timestamp to calculate when the window resets.

**Computing the retry delay:**

```bash
RESET=$(curl -sI http://localhost:4000/api/detections \
  -H "Authorization: Bearer sk_..." | \
  grep -i x-ratelimit-reset | awk '{print $2}' | tr -d '\r')
NOW=$(date +%s)
WAIT=$((RESET - NOW))
echo "Retry in ${WAIT} seconds"
```

## Disabling rate limiting for testing

Set the environment variable `DISABLE_RATE_LIMIT=true` to bypass all rate limit checks. This is intended for automated test environments only. The check is evaluated on every request, so the variable can be set without restarting the server.

```bash
DISABLE_RATE_LIMIT=true node dist/index.js
```

Never set `DISABLE_RATE_LIMIT=true` in production.

## Best practices

### Use exponential backoff

When you receive a `429`, wait before retrying. Prefer exponential backoff with jitter over a fixed delay:

```javascript
async function fetchWithBackoff(url, options, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;

    const reset = response.headers.get('X-RateLimit-Reset');
    const resetMs = reset ? (parseInt(reset, 10) * 1000) - Date.now() : 0;
    const jitter = Math.random() * 1000;
    const delay = Math.max(resetMs, Math.pow(2, attempt) * 500) + jitter;

    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
  }
  throw new Error('Rate limit exceeded after maximum retries');
}
```

### Check remaining count before sending bursts

Read `X-RateLimit-Remaining` from each response and pause your request loop when it approaches zero. Waiting for the window to reset is more reliable than reacting to a `429`.

### Cache GET responses client-side

GET responses from the Sentinel API are generally stable over short intervals. If your integration polls detections or alerts frequently, cache responses client-side using `X-RateLimit-Reset` as an upper bound on the cache TTL. This reduces request volume and avoids triggering the read limit.

### Use API keys scoped to read-only when possible

If your integration only reads data, create an API key with only the `api:read` scope. This documents intent, limits the blast radius of a key compromise, and keeps write-bucket consumption at zero.

### Separate read and write clients

If your integration performs both reads and writes at high volume, consider using two separate API keys (or two separate org sessions) so that write-heavy operations do not exhaust the read bucket for monitoring or dashboard polling.
