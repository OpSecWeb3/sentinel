/**
 * npm registry search client for org/scope bulk discovery.
 */

export interface NpmSearchResult {
  name: string;
  version: string;
  description: string;
}

export async function searchNpmScope(
  scope: string,
  limit: number = 100,
): Promise<NpmSearchResult[]> {
  // npm search API: text=scope:@myorg returns packages in that scope
  const url = `https://registry.npmjs.org/-/v1/search?text=scope:${encodeURIComponent(scope)}&size=${Math.min(limit, 250)}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`npm registry search failed (${res.status})`);
  }

  const data = (await res.json()) as {
    objects: Array<{
      package: {
        name: string;
        version: string;
        description?: string;
      };
    }>;
  };

  // Filter to exact scope match (npm search can return partial matches)
  const scopePrefix = scope.endsWith('/') ? scope : `${scope}/`;
  return data.objects
    .filter((obj) => obj.package.name.startsWith(scopePrefix) || obj.package.name === scope)
    .map((obj) => ({
      name: obj.package.name,
      version: obj.package.version,
      description: obj.package.description ?? '',
    }));
}
