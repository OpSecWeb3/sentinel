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
  ENCRYPTION_KEY: z.string().length(64),
  // Previous encryption key for key rotation (optional, decrypt-only)
  ENCRYPTION_KEY_PREV: z.string().length(64).optional(),

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
