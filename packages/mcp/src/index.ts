/**
 * Sentinel MCP Server — entry point
 *
 * Transport selection (env: MCP_TRANSPORT):
 *   "stdio"  (default) — Claude Desktop, CLI pipes.  Requires SENTINEL_API_KEY.
 *   "http"   — Streamable HTTP with OAuth 2.1 + PKCE or simple Bearer auth.
 *
 * See src/context.ts for the full list of env vars.
 */
import { TRANSPORT } from './context.js';
import { createServer } from './server.js';

const transport = TRANSPORT;

if (transport === 'http') {
  const { startHttpTransport } = await import('./http.js');
  await startHttpTransport(createServer());
} else {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
