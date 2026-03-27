/**
 * Shared Hono type definitions for the Sentinel platform.
 * All routers and middleware should use these types to ensure
 * c.get()/c.set() calls are properly typed.
 */
import type { Hono, Context, Next } from 'hono';
import type { Logger } from './logger.js';

export type AuthVariables = {
  userId: string;
  orgId: string;
  role: string;
  apiKeyId?: string;
  scopes?: string[];
  notifyKeyOrgId?: string;
  // Request context
  requestId: string;
  logger: Logger;
  // Validation middleware stores parsed data here
  validated_json?: unknown;
  validated_query?: unknown;
  validated_param?: unknown;
};

export type AppEnv = { Variables: AuthVariables };

export type AuthHono = Hono<AppEnv>;
export type AuthContext = Context<AppEnv>;
