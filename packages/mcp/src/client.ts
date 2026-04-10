/**
 * Thin HTTP client for the Sentinel API.
 * Handles auth headers, query string building, and error normalization.
 */
import { API_URL, API_KEY } from './context.js';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const entries: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) entries.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    } else {
      entries.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return entries.length > 0 ? `?${entries.join('&')}` : '';
}

const baseHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  // Bypass CSRF check for Bearer token requests (handled in API middleware)
};

// API_KEY may be empty when running in HTTP transport with OAuth —
// in that case, the auth middleware on the MCP side handles authentication,
// and per-request tokens could be forwarded. For now, if a key is configured
// we always send it.
if (API_KEY) {
  baseHeaders['Authorization'] = `Bearer ${API_KEY}`;
}

export async function apiGet(path: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = `${API_URL}${path}${buildQuery(params)}`;
  const res = await fetch(url, { headers: baseHeaders });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, `GET ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

export async function apiPost(path: string, body: unknown): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

export async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: baseHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `PATCH ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, { method: 'DELETE', headers: baseHeaders });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `DELETE ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/** Wrap an API call, returning { error } on failure instead of throwing. */
export async function safe(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: err.message, status: err.status };
    }
    return { error: String(err) };
  }
}

export function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Return structured content for tools that declare an outputSchema. */
export function structured(data: Record<string, unknown>): { structuredContent: Record<string, unknown>; content: [{ type: 'text'; text: string }] } {
  return {
    structuredContent: data,
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}
