/**
 * Solc-based storage layout discovery.
 *
 * Fetches verified Solidity source from Etherscan, compiles locally with
 * `storageLayout` in outputSelection, and persists discovered slots to
 * the chainContracts table. Ported from ChainAlert's storage-layout.ts
 * with Sentinel conventions (structured logger, getDb()).
 */
import solc from 'solc';
import { eq } from '@sentinel/db';
import { getDb } from '@sentinel/db';
import { chainContracts, chainNetworks } from '@sentinel/db/schema/chain';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { env } from '@sentinel/shared/env';

const log = rootLogger.child({ component: 'storage-layout' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StorageEntry {
  label: string;
  slot: string;
  offset: number;
  type: string;
}

interface StorageLayoutOutput {
  storage: StorageEntry[];
  types: Record<
    string,
    { encoding: string; label: string; numberOfBytes: string }
  >;
}

export interface DiscoveredSlot {
  label: string;
  slot: string;
  offset: number;
  typeName: string;
  numberOfBytes: number;
  suggested: boolean;
}

interface SourceData {
  sources: Record<string, { content: string }>;
  compilerVersion: string;
  optimization: boolean;
  runs: number;
  evmVersion: string;
  contractName: string;
  remappings: string[];
}

export interface EtherscanSourceResult {
  SourceCode: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  EVMVersion: string;
  ContractName: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERESTING_KEYWORDS = [
  'owner', 'admin', 'fee', 'limit', 'implementation', 'paused', 'balance',
  'threshold', 'guardian', 'manager', 'operator', 'treasury', 'vault',
  'beacon', 'pendingowner', 'minter', 'supply', 'cap', 'rate', 'delay',
  'locked', 'frozen', 'reward', 'escape', 'prove', 'proving', 'target',
  'stake', 'staking',
];

/** Max cached compiler instances — ~40MB each, capped for 384MB worker container. */
const COMPILER_CACHE_MAX = 5;
const COMPILER_VERSION_RE = /^v?\d+\.\d+\.\d+/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget entry point. Called after contract verification when
 * Etherscan did not provide a StorageLayout. Accepts the raw Etherscan
 * `getsourcecode` result so we avoid a duplicate API call.
 */
export function startLayoutDiscovery(
  contractId: number,
  sourceResult: EtherscanSourceResult | null,
): void {
  discoverLayout(contractId, sourceResult).catch((err) => {
    log.error({ err, contractId }, 'unhandled error in layout discovery');
  });
}

// ---------------------------------------------------------------------------
// Internal pipeline
// ---------------------------------------------------------------------------

export async function discoverLayout(
  contractId: number,
  sourceResult: EtherscanSourceResult | null,
): Promise<void> {
  const db = getDb();

  // Mark as pending
  await db
    .update(chainContracts)
    .set({ layoutStatus: 'pending' })
    .where(eq(chainContracts.id, contractId));

  try {
    // If no source result was passed, try fetching it
    let src = sourceResult;
    if (!src) {
      const [contract] = await db
        .select({ networkId: chainContracts.networkId, address: chainContracts.address })
        .from(chainContracts)
        .where(eq(chainContracts.id, contractId))
        .limit(1);

      if (!contract) throw new Error('Contract not found');

      const [network] = await db
        .select({ chainId: chainNetworks.chainId })
        .from(chainNetworks)
        .where(eq(chainNetworks.id, contract.networkId))
        .limit(1);

      if (!network) throw new Error('Network not found');

      src = await fetchSourceFromEtherscan(network.chainId, contract.address);
    }

    if (!src) {
      await db
        .update(chainContracts)
        .set({ layoutStatus: 'unsupported' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    // Reject Vyper contracts
    if (src.CompilerVersion.toLowerCase().includes('vyper')) {
      await db
        .update(chainContracts)
        .set({ layoutStatus: 'unsupported' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    const sourceData = parseSourceResult(src);
    if (!sourceData) {
      await db
        .update(chainContracts)
        .set({ layoutStatus: 'unsupported' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    // Load compiler
    const compiler = await loadCompiler(sourceData.compilerVersion);

    // Compile
    const input = buildCompilerInput(sourceData);
    const output = JSON.parse(
      compiler.compile(JSON.stringify(input)),
    ) as Record<string, unknown>;

    // Check for compilation errors
    const errors = (
      (output.errors as Array<{ severity: string; formattedMessage: string }>) ?? []
    ).filter((e) => e.severity === 'error');

    if (errors.length > 0) {
      log.error(
        { contractId, error: errors[0]?.formattedMessage },
        'solc compilation errors',
      );
      await db
        .update(chainContracts)
        .set({ layoutStatus: 'failed' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    // Extract layout
    const layout = extractLayout(output, sourceData.contractName);
    if (!layout || layout.storage.length === 0) {
      await db
        .update(chainContracts)
        .set({ storageLayout: [], layoutStatus: 'resolved' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    // Map all slots, marking keyword-matched ones as suggested
    const slots = mapSlots(layout);
    const suggestedCount = slots.filter((s) => s.suggested).length;

    await db
      .update(chainContracts)
      .set({ storageLayout: slots, layoutStatus: 'resolved' })
      .where(eq(chainContracts.id, contractId));

    log.info(
      { contractId, total: slots.length, suggested: suggestedCount },
      'storage layout discovered',
    );
  } catch (err) {
    log.error({ err, contractId }, 'layout discovery failed');
    await db
      .update(chainContracts)
      .set({ layoutStatus: 'failed' })
      .where(eq(chainContracts.id, contractId));
  }
}

// ---------------------------------------------------------------------------
// Etherscan source fetch (fallback when sourceResult not passed)
// ---------------------------------------------------------------------------

async function fetchSourceFromEtherscan(
  chainId: number,
  address: string,
): Promise<EtherscanSourceResult | null> {
  const apiKey = env().ETHERSCAN_API_KEY;
  if (!apiKey) return null;

  const baseUrl = 'https://api.etherscan.io/v2/api';
  const url = `${baseUrl}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      status: string;
      result: EtherscanSourceResult[];
    };
    if (data.status !== '1' || !data.result?.[0]) return null;

    const item = data.result[0];
    if (!item.SourceCode || item.SourceCode === '') return null;

    return item;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

function parseSourceResult(item: EtherscanSourceResult): SourceData | null {
  const contractName = item.ContractName;
  const compilerVersion = normalizeCompilerVersion(item.CompilerVersion);
  const optimization = item.OptimizationUsed === '1';
  const runs = parseInt(item.Runs, 10) || 200;
  const evmVersion = item.EVMVersion || 'default';

  if (!item.SourceCode) return null;

  let sources: Record<string, { content: string }>;
  let remappings: string[] = [];
  const sourceCode = item.SourceCode;

  if (sourceCode.startsWith('{{')) {
    // Standard JSON input format (double-braced)
    try {
      const inner = JSON.parse(sourceCode.slice(1, -1)) as {
        sources: Record<string, { content: string }>;
        settings?: { remappings?: string[] };
      };
      sources = inner.sources;
      remappings = inner.settings?.remappings ?? [];
    } catch {
      return null;
    }
  } else if (sourceCode.startsWith('{')) {
    // JSON multi-file format
    try {
      sources = JSON.parse(sourceCode) as Record<string, { content: string }>;
    } catch {
      sources = { [`${contractName}.sol`]: { content: sourceCode } };
    }
  } else {
    // Plain single-file source
    sources = { [`${contractName}.sol`]: { content: sourceCode } };
  }

  return { sources, compilerVersion, optimization, runs, evmVersion, contractName, remappings };
}

function normalizeCompilerVersion(raw: string): string {
  return raw.replace(/^v/, '');
}

// ---------------------------------------------------------------------------
// Compiler loading
// ---------------------------------------------------------------------------

const compilerCache = new Map<
  string,
  { compile: (input: string) => string }
>();

async function loadCompiler(
  version: string,
): Promise<{ compile: (input: string) => string }> {
  if (!COMPILER_VERSION_RE.test(version)) {
    throw new Error(`Invalid compiler version format: ${version}`);
  }

  const cached = compilerCache.get(version);
  if (cached) return cached;

  const compiler = await new Promise<{ compile: (input: string) => string }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out loading solc ${version}`)),
        60_000,
      );
      solc.loadRemoteVersion(
        `v${version}`,
        (err: Error | null, snapshot: unknown) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve(snapshot as { compile: (input: string) => string });
        },
      );
    },
  );

  // Evict oldest entry if cache is at capacity
  if (compilerCache.size >= COMPILER_CACHE_MAX) {
    const oldest = compilerCache.keys().next().value;
    if (oldest !== undefined) {
      compilerCache.delete(oldest);
    }
  }

  compilerCache.set(version, compiler);
  return compiler;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function buildCompilerInput(source: SourceData): object {
  return {
    language: 'Solidity',
    sources: source.sources,
    settings: {
      remappings: source.remappings.length > 0 ? source.remappings : undefined,
      optimizer: {
        enabled: source.optimization,
        runs: source.runs,
      },
      evmVersion:
        source.evmVersion === 'default' ? undefined : source.evmVersion,
      outputSelection: {
        '*': {
          '*': ['storageLayout'],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Layout extraction
// ---------------------------------------------------------------------------

function extractLayout(
  output: Record<string, unknown>,
  contractName: string,
): StorageLayoutOutput | null {
  const contractsOutput = output.contracts as Record<
    string,
    Record<string, { storageLayout?: StorageLayoutOutput }>
  >;
  if (!contractsOutput) return null;

  // Try exact match by contract name
  for (const fileContracts of Object.values(contractsOutput)) {
    if (fileContracts[contractName]?.storageLayout) {
      return fileContracts[contractName].storageLayout!;
    }
  }

  // Fallback: first contract with a non-empty storage layout
  for (const fileContracts of Object.values(contractsOutput)) {
    for (const contract of Object.values(fileContracts)) {
      if (contract.storageLayout?.storage?.length) {
        return contract.storageLayout;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Slot mapping
// ---------------------------------------------------------------------------

function mapSlots(layout: StorageLayoutOutput): DiscoveredSlot[] {
  return layout.storage.map((entry) => {
    const typeInfo = layout.types[entry.type];
    const lower = entry.label.toLowerCase();
    return {
      label: entry.label,
      slot: entry.slot,
      offset: entry.offset,
      typeName: typeInfo?.label ?? entry.type.replace(/^t_/, ''),
      numberOfBytes: parseInt(typeInfo?.numberOfBytes ?? '32', 10),
      suggested: INTERESTING_KEYWORDS.some((kw) => lower.includes(kw)),
    };
  });
}
