/**
 * MCP server context — configuration from environment variables.
 *
 * The MCP server is a thin HTTP client over the Sentinel API.
 * This gives us: multi-tenancy (auth scopes to org), audit logging, rate limiting.
 *
 * Required env vars:
 *   SENTINEL_API_URL  — e.g. http://localhost:4000
 *
 * Auth — at least one of:
 *   SENTINEL_API_KEY        — API key with api:read (and api:write for mutations).
 *                             Required for stdio transport. Optional for HTTP transport
 *                             when OAuth is configured.
 *
 * OAuth 2.1 (HTTP transport only):
 *   SENTINEL_OAUTH_ISSUER   — OAuth authorization server URL (e.g. https://auth.sentinel.example.com).
 *                             When set, the MCP HTTP transport uses full proxy OAuth 2.1 + PKCE.
 *   SENTINEL_OAUTH_AUDIENCE — (optional) The audience / resource identifier for token validation.
 *
 * Transport selection:
 *   MCP_TRANSPORT  — "stdio" (default) or "http"
 *   MCP_PORT       — HTTP port when using HTTP transport (default: 3000)
 */

export const API_URL = (process.env.SENTINEL_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** API key — required for stdio transport, optional for HTTP when OAuth is configured. */
export const API_KEY = process.env.SENTINEL_API_KEY ?? '';

/** OAuth 2.1 issuer URL. When set, enables full OAuth proxy on the HTTP transport. */
export const OAUTH_ISSUER = process.env.SENTINEL_OAUTH_ISSUER?.replace(/\/$/, '') ?? '';

/** Optional audience / resource identifier for OAuth token validation. */
export const OAUTH_AUDIENCE = process.env.SENTINEL_OAUTH_AUDIENCE ?? '';

/** Transport mode: "stdio" (default) or "http". */
export const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

/** HTTP port for the HTTP transport. */
export const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (TRANSPORT === 'stdio' && !API_KEY) {
  process.stderr.write('SENTINEL_API_KEY is required for stdio transport\n');
  process.exit(1);
}

if (TRANSPORT === 'http' && !API_KEY && !OAUTH_ISSUER) {
  process.stderr.write(
    'HTTP transport requires either SENTINEL_API_KEY or SENTINEL_OAUTH_ISSUER to be set\n',
  );
  process.exit(1);
}
