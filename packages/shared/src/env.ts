import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Auth
  SESSION_SECRET: z.string().min(32),

  // Encryption (64 hex chars = 32 bytes for AES-256)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 64 hex characters'),
  // Previous encryption key for key rotation (optional, decrypt-only)
  ENCRYPTION_KEY_PREV: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 64 hex characters').optional(),

  // API base URL (used for OAuth redirect_uri; must not be derived from request headers)
  API_BASE_URL: z.string().url().default('http://localhost:4000'),

  // CORS
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Slack OAuth (optional — not needed until Slack is configured)
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),

  // GitHub App (optional — not needed until GitHub App is configured)
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(), // PEM format for signing JWTs
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(), // shared secret or per-installation
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

  // Email (optional)
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('alerts@sentinel.dev'),

  // Chain module: RPC load balancing
  // Rotate primary RPC provider every N hours. Set to 0 to disable rotation.
  // 0 disables rotation; callers guard against division-by-zero.
  RPC_ROTATION_HOURS: z.coerce.number().int().nonnegative().default(10),

  // Etherscan (optional — used by chain module for ABI lookups)
  ETHERSCAN_API_KEY: z.string().optional(),

  // GitHub personal access token (optional — used by registry module for API rate limits)
  GITHUB_TOKEN: z.string().optional(),

  // Reverse-proxy trust: number of trusted proxies in front of the API server.
  // Used to extract the real client IP from X-Forwarded-For.
  TRUSTED_PROXY_COUNT: z.coerce.number().int().nonnegative().default(0),

  // Disable rate limiting (test/dev only)
  DISABLE_RATE_LIMIT: z.enum(['true', 'false']).default('false'),

  // Prometheus /metrics endpoint bearer token (optional — unauthenticated when unset)
  METRICS_TOKEN: z.string().optional(),

  // Observability (optional)
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function env(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

/** Reset the cached env so it is re-parsed from process.env on next call. Test-only. */
export function resetEnvCache(): void {
  _env = undefined;
}
