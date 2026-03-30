/**
 * Etherscan-compatible explorer API client.
 * Fetches contract ABIs and source verification status.
 */

export interface EtherscanAbiResult {
  abi: unknown[];
  contractName: string;
  /** Parsed storage layout from Etherscan getsourcecode, if available */
  storageLayout: { storage: { label: string; slot: string; type: string; offset: number }[] } | null;
  /** Raw source metadata from getsourcecode — passed to storage-layout discovery to avoid a duplicate API call */
  sourceResult?: {
    SourceCode: string;
    CompilerVersion: string;
    OptimizationUsed: string;
    Runs: string;
    EVMVersion: string;
    ContractName: string;
  } | null;
}

export interface FetchContractAbiOptions {
  /** EVM chain ID — when provided, uses Etherscan V2 unified endpoint. */
  chainId?: number;
  /** Etherscan API key — when provided, sent as the `apikey` query param. */
  apiKey?: string;
}

/** V1 explorer API bases (path `/api`) were deprecated Aug 2025; V2 is unified at api.etherscan.io/v2/api + chainid. */
function isDeprecatedEtherscanFamilyV1Api(explorerApi: string): boolean {
  const trimmed = explorerApi.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/api') return false;
    const host = u.hostname.toLowerCase();
    return (
      /^api(?:-[a-z0-9]+)?\.etherscan\.io$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.polygonscan\.com$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.arbiscan\.io$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.basescan\.org$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.bscscan\.com$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.ftmscan\.com$/i.test(host) ||
      /^api(?:-[a-z0-9]+)?\.[a-z0-9-]*scan\.(com|org|io|build|dev)$/i.test(host)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal retry helper — no external dependencies
// ---------------------------------------------------------------------------

/**
 * Executes `fn` up to `maxAttempts` times, waiting `baseDelayMs * 2^attempt`
 * between failures (exponential backoff). Only retries on network-level errors
 * or 5xx responses; 4xx responses (including API-level errors) are not retried
 * because they are deterministic.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
  baseDelayMs = 500,
  perAttemptTimeoutMs = 15_000,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      );
    }
    try {
      // Create a fresh timeout signal per attempt so a slow first attempt
      // does not consume the budget for subsequent retries.
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(perAttemptTimeoutMs) });
      // Only retry on server errors (5xx); all other status codes are final.
      if (res.status >= 500) {
        lastError = new Error(`Explorer API returned ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      // Network-level failure (timeout, DNS, etc.) — always retry.
      lastError = err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------

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
    // Use the Etherscan V2 unified endpoint when:
    //   (a) a chainId is provided, AND
    //   (b) explorerApi is empty OR is a known deprecated Etherscan-family V1 base
    //       (e.g. https://api.etherscan.io/api — still common in DB seeds / settings).
    //
    // Custom explorers (Blockscout, private chains) keep their URL when chainId is set.
    if (opts?.chainId && (!explorerApi || isDeprecatedEtherscanFamilyV1Api(explorerApi))) {
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

    // Use the caller-supplied explorerApi URL (legacy or custom explorer).
    // If a chainId is also present we still honour the user-provided base URL;
    // callers that truly want the V2 endpoint should leave explorerApi empty.
    const url = new URL(explorerApi);
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', action);
    url.searchParams.set('address', address);
    if (opts?.chainId && !url.searchParams.has('chainid')) {
      // Forward chainId so Etherscan-compatible explorers that support the
      // multi-chain parameter can also benefit from it.
      url.searchParams.set('chainid', String(opts.chainId));
    }
    if (opts?.apiKey && !url.searchParams.has('apikey')) {
      url.searchParams.set('apikey', opts.apiKey);
    }
    return url;
  };

  const url = buildUrl('getabi');

  // Primary ABI fetch — up to 3 attempts with exponential backoff.
  // Each individual attempt has its own 15-second timeout so a hung
  // connection does not consume all retries at once.
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { Accept: 'application/json' } },
  );

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

  // Extract contract name, storage layout, and source metadata from getsourcecode endpoint
  let contractName = 'Unknown';
  let storageLayout: EtherscanAbiResult['storageLayout'] = null;
  let sourceResult: EtherscanAbiResult['sourceResult'] = null;
  try {
    const srcUrl = buildUrl('getsourcecode');

    const srcRes = await fetchWithRetry(
      srcUrl.toString(),
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );

    if (srcRes.ok) {
      const srcData = (await srcRes.json()) as {
        status: string;
        result: Array<{
          ContractName?: string;
          StorageLayout?: string;
          SourceCode?: string;
          CompilerVersion?: string;
          OptimizationUsed?: string;
          Runs?: string;
          EVMVersion?: string;
        }>;
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
        // Capture source metadata for solc-based layout discovery
        if (row.SourceCode && row.SourceCode !== '' && row.CompilerVersion) {
          sourceResult = {
            SourceCode: row.SourceCode,
            CompilerVersion: row.CompilerVersion,
            OptimizationUsed: row.OptimizationUsed ?? '0',
            Runs: row.Runs ?? '200',
            EVMVersion: row.EVMVersion ?? '',
            ContractName: row.ContractName ?? contractName,
          };
        }
      }
    }
  } catch {
    // Best effort — contract name and storage layout are nice-to-have
  }

  return { abi, contractName, storageLayout, sourceResult };
}
