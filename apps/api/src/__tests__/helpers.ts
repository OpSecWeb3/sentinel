/**
 * Test helpers for Sentinel API integration tests.
 *
 * Provides functions to register users, log in, and make authenticated
 * requests using Hono's built-in app.request() (no running server needed).
 */
import type { Hono } from 'hono';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { createTestGithubInstallation } from '../../../../test/helpers/setup.js';

// We lazily import the app to allow setup.ts to configure env first.
let _app: Hono<AppEnv> | undefined;
export async function getApp(): Promise<Hono<AppEnv>> {
  if (!_app) {
    // Dynamic import so env vars are already set by setup.ts
    const mod = await import('../index.js');
    _app = mod.default;
  }
  return _app;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Make a JSON request to the Hono app. Returns the Response object.
 */
export async function appRequest(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: {
    body?: Record<string, unknown>;
    cookie?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
): Promise<Response> {
  let url = `http://localhost${path}`;
  if (opts.query) {
    const params = new URLSearchParams(opts.query);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
  };

  if (opts.cookie) {
    headers['Cookie'] = opts.cookie;
  }

  // Include CSRF defense header for cookie-authenticated state-changing requests.
  // The API requires X-Sentinel-Request on all non-GET/HEAD/OPTIONS requests that
  // carry a session cookie. Tests use session cookies, so we always include it.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && opts.cookie) {
    headers['X-Sentinel-Request'] = 'test';
  }

  const init: RequestInit = { method, headers };

  if (opts.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  return app.request(url, init);
}

/**
 * Extract Set-Cookie header value from a Response.
 */
export function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return '';
  // Return just the cookie key=value part (before any attributes)
  return setCookie.split(';')[0];
}

// ---------------------------------------------------------------------------
// Auth workflow helpers
// ---------------------------------------------------------------------------

export interface RegisterResult {
  res: Response;
  body: Record<string, unknown>;
  cookie: string;
}

/**
 * Register the first user (creates an org, gets admin role).
 * Returns the response body and session cookie.
 */
export async function registerAdmin(
  app: Hono<AppEnv>,
  overrides: Partial<{
    username: string;
    email: string;
    password: string;
    orgName: string;
  }> = {},
): Promise<RegisterResult> {
  const res = await appRequest(app, 'POST', '/auth/register', {
    body: {
      username: overrides.username ?? 'admin',
      email: overrides.email ?? 'admin@test.com',
      password: overrides.password ?? 'testpass123!',
      orgName: overrides.orgName ?? 'Test Org',
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  const cookie = extractCookie(res);
  const org = body.org as Record<string, unknown> | undefined;
  if (res.ok && org && typeof org.id === 'string') {
    await createTestGithubInstallation(org.id);
  }
  return { res, body, cookie };
}

/**
 * Register a second user using an invite secret (gets viewer role).
 */
export async function registerViewer(
  app: Hono<AppEnv>,
  inviteSecret: string,
  overrides: Partial<{
    username: string;
    email: string;
    password: string;
  }> = {},
): Promise<RegisterResult> {
  const res = await appRequest(app, 'POST', '/auth/register', {
    body: {
      username: overrides.username ?? 'viewer',
      email: overrides.email ?? 'viewer@test.com',
      password: overrides.password ?? 'testpass123!',
      inviteSecret,
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  const cookie = extractCookie(res);
  return { res, body, cookie };
}

/**
 * Log in with username/email and password. Returns session cookie.
 */
export async function login(
  app: Hono<AppEnv>,
  username: string,
  password: string,
): Promise<{ res: Response; body: Record<string, unknown>; cookie: string }> {
  const res = await appRequest(app, 'POST', '/auth/login', {
    body: { username, password },
  });
  const body = (await res.json()) as Record<string, unknown>;
  const cookie = extractCookie(res);
  return { res, body, cookie };
}

/**
 * Full admin setup: register + login. Returns cookie and invite secret.
 */
export async function setupAdmin(app: Hono<AppEnv>) {
  const reg = await registerAdmin(app);
  return {
    cookie: reg.cookie,
    inviteSecret: reg.body.inviteSecret as string,
    userId: (reg.body.user as Record<string, unknown>).id as string,
    orgId: (reg.body.org as Record<string, unknown>).id as string,
  };
}

/**
 * Full admin + viewer setup. Returns both cookies.
 */
export async function setupAdminAndViewer(app: Hono<AppEnv>) {
  const admin = await setupAdmin(app);
  const viewer = await registerViewer(app, admin.inviteSecret);
  return {
    admin,
    viewer: {
      cookie: viewer.cookie,
      userId: (viewer.body.user as Record<string, unknown>).id as string,
    },
  };
}

/**
 * Create an API key and return the raw key string.
 */
export async function createApiKey(
  app: Hono<AppEnv>,
  cookie: string,
  name = 'test-key',
  scopes = ['api:read'],
): Promise<{ key: string; id: string }> {
  const res = await appRequest(app, 'POST', '/auth/api-keys', {
    cookie,
    body: { name, scopes },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { key: body.key as string, id: body.id as string };
}
