/**
 * Etherscan-compatible explorer API client.
 * Fetches contract ABIs and source verification status.
 */

export interface EtherscanAbiResult {
  abi: unknown[];
  contractName: string;
  /** Parsed storage layout from Etherscan getsourcecode, if available */
  storageLayout: { storage: { label: string; slot: string; type: string; offset: number }[] } | null;
}

export interface FetchContractAbiOptions {
  /** EVM chain ID — when provided, uses Etherscan V2 unified endpoint. */
  chainId?: number;
  /** Etherscan API key — when provided, sent as the `apikey` query param. */
  apiKey?: string;
}

/**
 * Fetch a contract's ABI from an Etherscan-compatible explorer API.
 * Supports Etherscan V2 (when chainId is provided) and legacy explorer URLs.
 *
 * V2 format: https://api.etherscan.io/v2/api?chainid=X&module=contract&action=getabi&address=Y&apikey=Z
 * Legacy:    Uses the user-provided explorerApi URL with query params appended.
 */
export async function fetchContractAbi(
  explorerApi: string,
  address: string,
  opts?: FetchContractAbiOptions,
): Promise<EtherscanAbiResult> {
  const buildUrl = (action: 'getabi' | 'getsourcecode'): URL => {
    if (opts?.chainId) {
      // Etherscan V2 unified endpoint
      const url = new URL('https://api.etherscan.io/v2/api');
      url.searchParams.set('chainid', String(opts.chainId));
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', action);
      url.searchParams.set('address', address);
      if (opts.apiKey) {
        url.searchParams.set('apikey', opts.apiKey);
      }
      return url;
    }

    // Legacy: use the user-provided explorer URL
    const url = new URL(explorerApi);
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', action);
    url.searchParams.set('address', address);
    if (opts?.apiKey && !url.searchParams.has('apikey')) {
      url.searchParams.set('apikey', opts.apiKey);
    }
    return url;
  };

  const url = buildUrl('getabi');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Explorer API returned ${res.status}`);
  }

  const data = (await res.json()) as {
    status: string;
    message: string;
    result: string;
  };

  if (data.status !== '1' || data.message === 'NOTOK') {
    throw new Error(`Explorer API error: ${data.result ?? data.message}`);
  }

  const abi = JSON.parse(data.result) as unknown[];

  // Extract contract name and storage layout from getsourcecode endpoint
  let contractName = 'Unknown';
  let storageLayout: EtherscanAbiResult['storageLayout'] = null;
  try {
    const srcUrl = buildUrl('getsourcecode');

    const srcRes = await fetch(srcUrl.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (srcRes.ok) {
      const srcData = (await srcRes.json()) as {
        status: string;
        result: Array<{ ContractName?: string; StorageLayout?: string }>;
      };
      if (srcData.status === '1' && srcData.result?.[0]) {
        const row = srcData.result[0];
        if (row.ContractName) {
          contractName = row.ContractName;
        }
        // StorageLayout is a JSON string when the contract was compiled with --storage-layout
        if (row.StorageLayout && row.StorageLayout !== '') {
          try {
            const parsed = JSON.parse(row.StorageLayout) as {
              storage?: { label: string; slot: string; type: string; offset: number }[];
            };
            if (Array.isArray(parsed.storage) && parsed.storage.length > 0) {
              storageLayout = { storage: parsed.storage };
            }
          } catch {
            // StorageLayout parsing is best-effort
          }
        }
      }
    }
  } catch {
    // Best effort — contract name and storage layout are nice-to-have
  }

  return { abi, contractName, storageLayout };
}
