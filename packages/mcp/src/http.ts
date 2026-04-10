/**
 * Streamable HTTP transport for the Sentinel MCP server.
 *
 * Features:
 *   - Stateful sessions (one transport per client session)
 *   - DNS rebinding protection via Express middleware
 *   - JSON-RPC over HTTP POST (requests), GET (SSE stream), DELETE (session close)
 *   - OAuth 2.1 + PKCE when SENTINEL_OAUTH_ISSUER is set
 *   - Simple Bearer auth fallback when only SENTINEL_API_KEY is set
 *   - Session cleanup on close
 */
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createServer } from './server.js';
import { API_URL, OAUTH_ISSUER, API_KEY } from './context.js';
import { setupAuth } from './auth.js';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.MCP_HTTP_PORT ?? '3100', 10);
const HOST = process.env.MCP_HTTP_HOST ?? '127.0.0.1';

const MCP_PATH = '/mcp';

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
export async function startHttpTransport(initialServer: McpServer): Promise<void> {
  // The initial server instance is used as a factory template — we create
  // a fresh McpServer per session so tool state doesn't leak between clients.
  void initialServer; // unused directly; sessions create their own

  // Build Express app with DNS rebinding protection
  const app = createMcpExpressApp({ host: HOST });

  // ------------------------------------------------------------------
  // Auth setup — OAuth 2.1 or simple Bearer depending on config
  // ------------------------------------------------------------------
  const mcpServerUrl = new URL(`http://${HOST}:${PORT}${MCP_PATH}`);
  const useAuth = !!(OAUTH_ISSUER || API_KEY);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let authMiddleware: ((...args: any[]) => any) | undefined;

  if (useAuth) {
    const auth = setupAuth(mcpServerUrl);

    // Mount the OAuth router (metadata + endpoints) at the app root
    if (auth.authRouter) {
      app.use(auth.authRouter);
    }

    authMiddleware = auth.authMiddleware;
  }

  // ------------------------------------------------------------------
  // MCP routes
  // ------------------------------------------------------------------

  // POST /mcp — JSON-RPC requests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postHandler = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New initialization request (no session ID)
      if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server: mcpServer });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        const mcpServer = createServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Session not found
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    } catch (err) {
      process.stderr.write(`MCP HTTP POST error: ${err}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getHandler = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deleteHandler = async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    try {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`MCP HTTP DELETE error: ${err}\n`);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  };

  // Wire up routes with optional auth middleware
  if (authMiddleware) {
    app.post(MCP_PATH, authMiddleware, postHandler);
    app.get(MCP_PATH, authMiddleware, getHandler);
    app.delete(MCP_PATH, authMiddleware, deleteHandler);
  } else {
    app.post(MCP_PATH, postHandler);
    app.get(MCP_PATH, getHandler);
    app.delete(MCP_PATH, deleteHandler);
  }

  // Health check (no auth required)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get('/health', (_req: any, res: any) => {
    res.json({
      status: 'ok',
      api: API_URL,
      transport: 'http',
      sessions: sessions.size,
      auth: OAUTH_ISSUER ? 'oauth' : API_KEY ? 'bearer' : 'none',
    });
  });

  // ------------------------------------------------------------------
  // Start listening
  // ------------------------------------------------------------------
  app.listen(PORT, HOST, () => {
    const authMode = OAUTH_ISSUER ? 'OAuth 2.1 (proxy)' : API_KEY ? 'Bearer token' : 'none';
    process.stderr.write(`Sentinel MCP (Streamable HTTP) listening on http://${HOST}:${PORT}${MCP_PATH}\n`);
    process.stderr.write(`  Auth: ${authMode}\n`);
    process.stderr.write(`  Health: http://${HOST}:${PORT}/health\n`);
  });

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      process.stderr.write(`\nShutting down (${signal})...\n`);
      for (const [, session] of sessions) {
        try {
          await session.transport.close();
        } catch {
          // ignore cleanup errors
        }
      }
      process.exit(0);
    });
  }
}
