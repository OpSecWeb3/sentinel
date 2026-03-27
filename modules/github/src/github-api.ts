/**
 * GitHub App API utilities.
 * Handles JWT generation, installation access tokens, and authenticated requests.
 */
import crypto from 'node:crypto';
import { env } from '@sentinel/shared/env';

// ---------------------------------------------------------------------------
// GitHub App JWT generation (RS256)
// ---------------------------------------------------------------------------

/**
 * Generate a GitHub App JWT for authenticating as the app itself.
 * JWTs are valid for up to 10 minutes per GitHub's requirements.
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-jwt
 */
export function generateAppJwt(): string {
  const appId = env().GITHUB_APP_ID;
  const privateKey = env().GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,    // issued 60s in the past to allow for clock drift
    exp: now + 600,   // 10 minute maximum
    iss: appId,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// Installation access tokens
// ---------------------------------------------------------------------------

export interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
}

/**
 * Get an installation access token for making API calls on behalf of an installation.
 * @see https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token
 */
export async function getInstallationAccessToken(
  installationId: number | bigint,
): Promise<InstallationToken> {
  const jwt = generateAppJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions: Record<string, string>;
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
    permissions: data.permissions,
  };
}

// ---------------------------------------------------------------------------
// Installation details
// ---------------------------------------------------------------------------

export interface GitHubInstallationDetails {
  id: number;
  app_slug: string;
  target_type: string;
  account: {
    login: string;
    id: number;
    type: string;
  };
  permissions: Record<string, string>;
  events: string[];
}

/**
 * Fetch installation details from GitHub using an app JWT.
 * @see https://docs.github.com/en/rest/apps/apps#get-an-installation
 */
export async function getInstallationDetails(
  installationId: number,
): Promise<GitHubInstallationDetails> {
  const jwt = generateAppJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${body}`);
  }

  return (await res.json()) as GitHubInstallationDetails;
}

// ---------------------------------------------------------------------------
// Authenticated GitHub API calls
// ---------------------------------------------------------------------------

export interface GitHubApiOptions {
  method?: string;
  body?: unknown;
  token: string;
  /** @internal Used to track retry attempts on 429 rate limiting. */
  _retryCount?: number;
}

/**
 * Allowed GitHub API hostnames. Prevents SSRF by rejecting arbitrary URLs.
 */
function getAllowedGitHubHosts(): Set<string> {
  const hosts = new Set(['api.github.com']);
  const envVars = env() as Record<string, unknown>;
  const gheHost = envVars.GITHUB_ENTERPRISE_HOST;
  if (typeof gheHost === 'string' && gheHost.length > 0) {
    hosts.add(gheHost);
  }
  return hosts;
}

function validateGitHubUrl(url: string): void {
  const parsed = new URL(url);
  if (!getAllowedGitHubHosts().has(parsed.hostname)) {
    throw new Error(`Blocked request to disallowed host: ${parsed.hostname}`);
  }
}

/**
 * Make an authenticated GitHub API call using an installation access token.
 * Includes SSRF protection and GitHub API rate limit handling.
 */
export async function githubApiFetch(
  path: string,
  options: GitHubApiOptions,
): Promise<Response> {
  const url = path.startsWith('https://')
    ? path
    : `https://api.github.com${path}`;

  // SSRF protection: validate hostname
  validateGitHubUrl(url);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // Handle rate limiting (429 explicit, or 403 with exhausted rate limit)
  const isRateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get('X-RateLimit-Remaining') === '0');

  if (isRateLimited) {
    const attempt = options._retryCount ?? 0;
    if (attempt >= 3) {
      throw new Error(`GitHub API rate limited after ${attempt} retries: ${path}`);
    }
    const retryAfter = response.headers.get('Retry-After');
    const resetHeader = response.headers.get('X-RateLimit-Reset');
    let waitMs: number;
    if (retryAfter) {
      waitMs = Math.min(parseInt(retryAfter, 10) * 1000, 120_000);
    } else if (resetHeader) {
      waitMs = Math.min(
        Math.max(0, parseInt(resetHeader, 10) * 1000 - Date.now()),
        120_000,
      );
    } else {
      waitMs = 60_000;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return githubApiFetch(path, { ...options, _retryCount: attempt + 1 });
  }

  // Proactive rate limit awareness: slow down when running low
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const resetHeader = response.headers.get('X-RateLimit-Reset');
  if (remaining !== null && parseInt(remaining, 10) < 100 && resetHeader) {
    const resetTime = parseInt(resetHeader, 10) * 1000;
    const delayMs = Math.max(0, Math.min(resetTime - Date.now(), 10_000));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
