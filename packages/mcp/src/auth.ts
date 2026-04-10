/**
 * OAuth 2.1 authentication for the Sentinel MCP HTTP transport.
 *
 * Two modes:
 *  1. **Proxy OAuth** — when SENTINEL_OAUTH_ISSUER is set, the MCP server acts as a
 *     resource server that validates tokens against the upstream Sentinel authorization
 *     server and proxies all OAuth flows (authorize, token, registration, revocation).
 *  2. **Simple Bearer** — when only SENTINEL_API_KEY is set (no SENTINEL_OAUTH_ISSUER),
 *     the middleware validates tokens by forwarding them to the Sentinel API's own
 *     /api/auth/verify endpoint.
 *
 * Both modes use the SDK's `requireBearerAuth()` middleware.
 */
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  OAUTH_ISSUER,
  OAUTH_AUDIENCE,
  API_URL,
  API_KEY,
} from './context.js';

/**
 * Generic Express-compatible middleware type.
 * We define this locally to avoid a direct dependency on @types/express,
 * which is not installed in this project.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Middleware = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Token verifier — validates a Bearer token against the Sentinel API
// ---------------------------------------------------------------------------

/**
 * Creates a token verifier that calls the Sentinel API to validate tokens.
 *
 * When a dedicated OAuth issuer is configured, it calls the issuer's introspection endpoint.
 * Otherwise it falls back to the Sentinel API's own verify endpoint.
 */
function createTokenVerifier(introspectionEndpoint?: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // If we have an introspection endpoint from the issuer, use it
      if (introspectionEndpoint) {
        const res = await fetch(introspectionEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => 'unknown error');
          throw new Error(`Token introspection failed: ${res.status} ${text}`);
        }

        const data = (await res.json()) as Record<string, unknown>;

        if (data.active === false) {
          throw new Error('Token is not active');
        }

        return {
          token,
          clientId: (data.client_id as string) ?? 'unknown',
          scopes: typeof data.scope === 'string' ? (data.scope as string).split(' ') : [],
          expiresAt: typeof data.exp === 'number' ? (data.exp as number) : undefined,
        };
      }

      // Fallback: validate against the Sentinel API itself.
      // We call a lightweight endpoint that returns the token's session info.
      const verifyUrl = `${API_URL}/api/auth/verify`;
      const res = await fetch(verifyUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new Error(`Sentinel token verification failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as Record<string, unknown>;

      return {
        token,
        clientId: (data.client_id as string) ?? (data.org_id as string) ?? 'sentinel',
        scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : ['api:read'],
        expiresAt: typeof data.exp === 'number' ? (data.exp as number) : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AuthSetup {
  /** Express middleware that validates Bearer tokens on every MCP request. */
  authMiddleware: Middleware;
  /** Auth router to mount at app root (OAuth metadata + endpoints). May be null for simple Bearer mode. */
  authRouter: Middleware | null;
  /** The OAuth provider instance (for advanced use). */
  provider: OAuthServerProvider | OAuthTokenVerifier;
}

/**
 * Build the auth middleware and (optionally) the OAuth router for the HTTP transport.
 *
 * @param mcpServerUrl  The public URL of the MCP HTTP endpoint (e.g. http://localhost:3000/mcp).
 *                      Used for resource metadata.
 */
export function setupAuth(mcpServerUrl: URL): AuthSetup {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);

  // ------------------------------------------------------------------
  // Mode 1: Full proxy OAuth — SENTINEL_OAUTH_ISSUER is configured
  // ------------------------------------------------------------------
  if (OAUTH_ISSUER) {
    const issuerUrl = new URL(OAUTH_ISSUER);

    // Derive standard endpoints from the issuer URL
    const authorizationUrl = `${OAUTH_ISSUER}/authorize`;
    const tokenUrl = `${OAUTH_ISSUER}/token`;
    const revocationUrl = `${OAUTH_ISSUER}/revoke`;
    const registrationUrl = `${OAUTH_ISSUER}/register`;
    const introspectionUrl = `${OAUTH_ISSUER}/introspect`;

    const verifier = createTokenVerifier(introspectionUrl);

    const provider = new ProxyOAuthServerProvider({
      endpoints: {
        authorizationUrl,
        tokenUrl,
        revocationUrl,
        registrationUrl,
      },
      verifyAccessToken: (token: string) => verifier.verifyAccessToken(token),
      getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> => {
        // Proxy client lookup to the upstream server
        try {
          const res = await fetch(`${OAUTH_ISSUER}/register/${encodeURIComponent(clientId)}`);
          if (!res.ok) return undefined;
          return (await res.json()) as OAuthClientInformationFull;
        } catch {
          return undefined;
        }
      },
    });

    const authRouter = mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: mcpServerUrl,
      serviceDocumentationUrl: new URL(`${API_URL}/docs`),
      scopesSupported: ['api:read', 'api:write'],
      resourceServerUrl: mcpServerUrl,
      resourceName: 'Sentinel MCP Server',
    });

    const authMiddleware = requireBearerAuth({
      verifier: provider,
      requiredScopes: [],
      resourceMetadataUrl,
    });

    return { authMiddleware, authRouter, provider };
  }

  // ------------------------------------------------------------------
  // Mode 2: Simple Bearer — validate tokens against Sentinel API
  // ------------------------------------------------------------------
  const verifier = createTokenVerifier();

  // In simple Bearer mode, we still advertise resource metadata so MCP
  // clients know they need a token, but we skip the full OAuth router.
  const authMiddleware = requireBearerAuth({
    verifier,
    requiredScopes: [],
    resourceMetadataUrl,
  });

  // No full OAuth router in simple mode — clients supply a pre-existing token.
  // But we do want to serve protected resource metadata so clients can discover
  // that auth is required.
  let metadataRouter: Middleware | null = null;

  if (OAUTH_AUDIENCE) {
    // Build a minimal OAuth metadata object pointing clients to the Sentinel API
    const oauthMetadata: OAuthMetadata = {
      issuer: API_URL,
      authorization_endpoint: `${API_URL}/oauth/authorize`,
      token_endpoint: `${API_URL}/oauth/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    };

    metadataRouter = mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: mcpServerUrl,
      scopesSupported: ['api:read', 'api:write'],
      resourceName: 'Sentinel MCP Server',
    }) as Middleware;
  }

  return { authMiddleware, authRouter: metadataRouter, provider: verifier };
}
