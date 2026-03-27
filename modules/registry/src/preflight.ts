/**
 * Pre-flight tag/version count validation.
 * Checks registry total count before queueing a poll job to prevent
 * importing artifacts with an unmanageable number of tags.
 */

const DOCKER_HUB_BASE = 'https://hub.docker.com/v2';
const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';
const DEFAULT_THRESHOLD = 1000;
const TIMEOUT_MS = 10_000;

export interface PreflightResult {
  totalCount: number;
  ok: boolean;
  message?: string;
}

async function dockerHubTagCount(repoName: string): Promise<number> {
  const url = `${DOCKER_HUB_BASE}/repositories/${repoName}/tags?page_size=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
  const data = (await res.json()) as { count: number };
  return data.count;
}

async function npmVersionCount(packageName: string): Promise<number> {
  const url = `${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const data = (await res.json()) as { versions: Record<string, unknown> };
  return Object.keys(data.versions).length;
}

/**
 * Check the total tag/version count for an artifact before queueing a poll.
 * Returns `{ ok: false }` with a message if the count exceeds the threshold.
 */
export async function preflightTagCount(
  registry: 'docker_hub' | 'npmjs',
  name: string,
  threshold = DEFAULT_THRESHOLD,
): Promise<PreflightResult> {
  const totalCount = registry === 'docker_hub'
    ? await dockerHubTagCount(name)
    : await npmVersionCount(name);

  if (totalCount > threshold) {
    return {
      totalCount,
      ok: false,
      message: `Artifact "${name}" has ${totalCount} tags/versions, exceeding the maximum of ${threshold}. Use more specific tagPatterns or ignorePatterns to reduce the scope.`,
    };
  }

  return { totalCount, ok: true };
}
