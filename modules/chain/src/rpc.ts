/**
 * RPC client utility for the chain module.
 *
 * Provides low-level JSON-RPC helpers for Ethereum-compatible networks:
 * eth_blockNumber, eth_getLogs, eth_getBalance, eth_getStorageAt, eth_call.
 *
 * Ported from ChainAlert's @chainalert/shared/rpc and state-poller utilities.
 */
import { logger as rootLogger } from '@sentinel/shared/logger';
import { trackRpcCall } from './rpc-usage.js';

const log = rootLogger.child({ component: 'chain-rpc' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcClientOptions {
  /** Maximum retries per call (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  retryDelayMs?: number;
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
}

export interface RpcClient {
  /** The chain ID this client targets */
  chainId: number;
  /** Call eth_blockNumber and return the latest block number */
  getBlockNumber(): Promise<bigint>;
  /** Call eth_getLogs for a block range with optional address/topic filters */
  getLogs(params: GetLogsParams): Promise<RpcLog[]>;
  /** Call eth_getBalance for an address at latest block */
  getBalance(address: string): Promise<bigint>;
  /** Call eth_getStorageAt for a storage slot at latest block */
  getStorageAt(address: string, slot: string): Promise<string>;
  /** Call eth_call (read-only contract call) */
  call(params: EthCallParams): Promise<string>;
  /** Get block by number, optionally including full transactions */
  getBlock(blockNumber: bigint, includeTransactions?: boolean): Promise<RpcBlock>;
}

export interface GetLogsParams {
  fromBlock: bigint;
  toBlock: bigint;
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  transactionHash: string;
  logIndex: number | null;
  transactionIndex: number | null;
}

export interface EthCallParams {
  to: string;
  data: string;
  /** Block tag (default: 'latest') */
  blockTag?: string;
}

export interface RpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
}

export interface RpcBlock {
  number: string;
  timestamp: string;
  transactions: string[] | RpcTransaction[];
}

// ---------------------------------------------------------------------------
// Internal: JSON-RPC transport
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Wrap at Number.MAX_SAFE_INTEGER to prevent the counter from ever exceeding
// the safe integer range.  JSON-RPC only requires that IDs are unique within
// an in-flight request set, not globally unique across all time, so recycling
// is fine in practice (a single process would take ~285 million years at
// 1 000 calls/s to wrap around even without the guard).
let _nextId = 1;

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  opts: Required<RpcClientOptions>,
): Promise<unknown> {
  const body: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: _nextId,
    method,
    params,
  };
  _nextId = (_nextId % Number.MAX_SAFE_INTEGER) + 1;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`RPC HTTP ${resp.status}: ${resp.statusText}`);
      }

      const json = (await resp.json()) as JsonRpcResponse;

      if (json.error) {
        throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
      }

      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error(`RPC call ${method} failed after ${opts.maxRetries + 1} attempts`);
}

// ---------------------------------------------------------------------------
// URL rotation (ported from ChainAlert's rotateUrls)
// ---------------------------------------------------------------------------

/**
 * Simple round-robin URL rotation. Returns the URLs reordered so the
 * "primary" URL changes based on the current hour.
 */
export function rotateUrls(urls: string[], rotationWindowHours?: number): string[] {
  if (urls.length <= 1 || !rotationWindowHours || rotationWindowHours <= 0) return urls;
  const hoursSinceEpoch = Math.floor(Date.now() / (rotationWindowHours * 3600 * 1000));
  const idx = hoursSinceEpoch % urls.length;
  return [...urls.slice(idx), ...urls.slice(0, idx)];
}

// ---------------------------------------------------------------------------
// Public: createRpcClient
// ---------------------------------------------------------------------------

/**
 * Create an RPC client for a specific chain. Supports multiple RPC URLs
 * with automatic failover — if the primary URL fails, the next one is tried.
 */
// ---------------------------------------------------------------------------
// SSRF protection: validate RPC URLs
// ---------------------------------------------------------------------------

/** Private/reserved IPv4 CIDR ranges */
const PRIVATE_IP_PATTERNS = [
  /^127\./,              // 127.0.0.0/8 loopback
  /^10\./,               // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./,         // 192.168.0.0/16
  /^169\.254\./,         // link-local
  /^0\./,                // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // 100.64.0.0/10 (CGNAT)
  /^198\.1[89]\./,       // 198.18.0.0/15 benchmark testing (RFC 2544)
  /^2[4-5]\d\./,         // 240.0.0.0/4 reserved (RFC 1112)
];

/** Private/reserved IPv6 patterns (bracketed as they appear in URL hostnames) */
const PRIVATE_IPV6_PATTERNS = [
  /^\[::1?\]$/,                        // ::1 loopback and :: unspecified
  /^\[fe80:/i,                         // fe80::/10 link-local
  /^\[fc/i,                            // fc00::/7 unique-local (fc00::/8)
  /^\[fd/i,                            // fc00::/7 unique-local (fd00::/8)
  /^\[::ffff:\d{1,3}\.\d{1,3}\./i,    // ::ffff:x.x.x.x IPv4-mapped IPv6
  /^\[100::/,                          // 100::/64 discard prefix (RFC 6666)
  /^\[2001:db8:/i,                     // 2001:db8::/32 documentation
  /^\[0*:0*:0*:0*:0*:(0*:)?\d{1,3}\./, // ::x.x.x.x IPv4-compatible (deprecated)
];

function isPrivateIp(ip: string): boolean {
  if (ip === '255.255.255.255') return true; // broadcast
  // Check IPv4 patterns
  if (PRIVATE_IP_PATTERNS.some((p) => p.test(ip))) return true;
  // Check IPv6 patterns (hostnames are bracketed in URLs, e.g. [::1])
  if (ip.startsWith('[') && PRIVATE_IPV6_PATTERNS.some((p) => p.test(ip))) return true;
  // Check IPv4-mapped IPv6 where the embedded IPv4 is private (e.g. [::ffff:10.0.0.1])
  const v4MappedMatch = ip.match(/^\[::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]$/i);
  if (v4MappedMatch) {
    return PRIVATE_IP_PATTERNS.some((p) => p.test(v4MappedMatch[1]!));
  }
  return false;
}

/**
 * Validate that an RPC URL is safe:
 * - Must use HTTPS (or HTTP only for localhost in development)
 * - Hostname must not resolve to private/internal IPs
 *
 * KNOWN LIMITATION — DNS rebinding (SSRF via DNS):
 * -------------------------------------------------
 * This function inspects the *literal hostname string* only.  It cannot
 * prevent an attacker from registering a public domain (e.g. evil.com) that
 * resolves to a private IP address (e.g. 192.168.1.1) at connection time —
 * a technique known as DNS rebinding.  Full prevention requires one or more
 * of the following at the infrastructure level:
 *
 *   1. Egress firewall rules that block outbound connections to RFC-1918 and
 *      link-local CIDR ranges (10/8, 172.16/12, 192.168/16, 169.254/16, etc.)
 *      regardless of what hostname was used to establish the connection.
 *   2. A DNS resolver that refuses to answer public names with private IPs
 *      (RPZ / Response Policy Zones, e.g. bind's "rpz-ip" rule).
 *   3. A forward-proxy / egress proxy that performs its own IP-level checks
 *      after resolving the hostname (e.g. Squid with ACL deny to_localhost).
 *
 * Application-level DNS pre-resolution (resolve → check → connect) is not
 * implemented here because it introduces a TOCTOU race (the IP could change
 * between the check and the actual connection), requires an extra round-trip
 * on every call, and is platform-dependent.  Infrastructure controls are the
 * correct mitigation layer.
 */
function validateRpcUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }

  // Enforce HTTPS in production; allow HTTP only in development/test
  const isProduction = process.env.NODE_ENV === 'production';

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`RPC URL must use HTTPS: ${url}`);
  }

  if (parsed.protocol === 'http:' && isProduction) {
    throw new Error(`RPC URL must use HTTPS in production (got HTTP): ${url}`);
  }

  // Block obviously internal hostnames
  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '[::]' ||
    hostname === '[::1]' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    // Common unregistered private LAN TLDs used by home routers and
    // enterprise networks — these will never resolve on the public internet
    // but could be reached via DNS rebinding from a controlled domain.
    hostname.endsWith('.lan') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.intranet') ||
    hostname === 'metadata.google.internal' ||
    hostname === '169.254.169.254'
  ) {
    throw new Error(`RPC URL targets a private/internal host: ${url}`);
  }

  // Check for IP addresses in the hostname
  if (isPrivateIp(hostname)) {
    throw new Error(`RPC URL resolves to a private IP range: ${url}`);
  }

  // Warn about non-HTTPS URLs in non-production environments
  if (parsed.protocol === 'http:') {
    log.warn({ hostname: safeHostname(url) }, 'RPC URL uses insecure HTTP (allowed outside production)');
  }
}

export function createRpcClient(
  rpcUrls: string[],
  chainId: number,
  clientOpts?: RpcClientOptions & { rotationWindowHours?: number },
): RpcClient {
  if (rpcUrls.length === 0) {
    throw new Error('At least one RPC URL is required');
  }

  // Validate all URLs for SSRF safety
  for (const url of rpcUrls) {
    validateRpcUrl(url);
  }

  const opts: Required<RpcClientOptions> = {
    maxRetries: clientOpts?.maxRetries ?? 3,
    retryDelayMs: clientOpts?.retryDelayMs ?? 1000,
    timeoutMs: clientOpts?.timeoutMs ?? 15_000,
  };

  const rotationWindowHours = clientOpts?.rotationWindowHours;

  // Try each URL in order; if all fail, throw the last error
  async function callWithFailover(method: string, params: unknown[]): Promise<unknown> {
    // Re-compute rotation on every call so long-lived clients rotate providers
    const orderedUrls = rotateUrls(rpcUrls, rotationWindowHours);
    let lastError: Error | undefined;
    for (const url of orderedUrls) {
      try {
        const result = await rpcCall(url, method, params, opts);
        trackRpcCall(method, 'ok');
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn({ method, hostname: safeHostname(url), err: lastError }, 'RPC call failed, trying next URL');
      }
    }
    trackRpcCall(method, 'error');
    throw lastError ?? new Error(`All RPC URLs failed for ${method}`);
  }

  return {
    chainId,

    async getBlockNumber(): Promise<bigint> {
      const result = await callWithFailover('eth_blockNumber', []);
      return BigInt(result as string);
    },

    async getLogs(params: GetLogsParams): Promise<RpcLog[]> {
      const filter: Record<string, unknown> = {
        fromBlock: '0x' + params.fromBlock.toString(16),
        toBlock: '0x' + params.toBlock.toString(16),
      };
      if (params.address) filter.address = params.address;
      if (params.topics) filter.topics = params.topics;

      const result = (await callWithFailover('eth_getLogs', [filter])) as Array<{
        address: string;
        topics: string[];
        data: string;
        blockNumber: string;
        transactionHash: string;
        logIndex: string;
        transactionIndex: string;
      }>;

      return result.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber ? String(BigInt(l.blockNumber)) : null,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex != null ? Number(l.logIndex) : null,
        transactionIndex: l.transactionIndex != null ? Number(l.transactionIndex) : null,
      }));
    },

    async getBalance(address: string): Promise<bigint> {
      const result = await callWithFailover('eth_getBalance', [address, 'latest']);
      return BigInt(result as string);
    },

    async getStorageAt(address: string, slot: string): Promise<string> {
      const result = await callWithFailover('eth_getStorageAt', [address, slot, 'latest']);
      return result as string;
    },

    async call(params: EthCallParams): Promise<string> {
      const result = await callWithFailover('eth_call', [
        { to: params.to, data: params.data },
        params.blockTag ?? 'latest',
      ]);
      return result as string;
    },

    async getBlock(blockNumber: bigint, includeTransactions = false): Promise<RpcBlock> {
      const hex = '0x' + blockNumber.toString(16);
      const result = (await callWithFailover('eth_getBlockByNumber', [
        hex,
        includeTransactions,
      ])) as Record<string, unknown>;

      if (!result) {
        throw new Error(`Block ${blockNumber} not found`);
      }

      const txs = result.transactions as unknown[];

      let transactions: string[] | RpcTransaction[];
      if (includeTransactions && txs?.length > 0 && typeof txs[0] === 'object') {
        transactions = (txs as Array<Record<string, unknown>>).map((tx) => ({
          hash: tx.hash as string,
          from: tx.from as string,
          to: (tx.to as string) ?? null,
          input: tx.input as string,
          value: safeBigIntStr(tx.value as string | undefined),
          blockNumber: tx.blockNumber ? String(BigInt(tx.blockNumber as string)) : null,
        }));
      } else {
        transactions = (txs as string[]) ?? [];
      }

      return {
        number: result.number ? String(BigInt(result.number as string)) : '0',
        timestamp: result.timestamp ? String(BigInt(result.timestamp as string)) : '0',
        transactions,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely convert a hex or numeric string to a decimal string via BigInt. Returns '0' on failure. */
function safeBigIntStr(value: string | undefined | null): string {
  if (!value) return '0';
  try {
    return String(BigInt(value));
  } catch {
    return '0';
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// ERC-20 balance helper (eth_call with balanceOf)
// ---------------------------------------------------------------------------

const ERC20_BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

/**
 * Get ERC-20 token balance for an address.
 * If tokenAddress is undefined, returns native ETH balance.
 */
export async function getTokenBalance(
  client: RpcClient,
  address: string,
  tokenAddress?: string,
): Promise<bigint> {
  if (!tokenAddress) {
    return client.getBalance(address);
  }

  // Encode balanceOf(address) call
  const paddedAddress = address.toLowerCase().replace('0x', '').padStart(64, '0');
  const data = ERC20_BALANCE_OF_SELECTOR + paddedAddress;

  const result = await client.call({ to: tokenAddress, data });

  // Result is a hex-encoded uint256
  if (!result || result === '0x' || result === '0x0') return 0n;
  return BigInt(result);
}

// ---------------------------------------------------------------------------
// View function call helper (ported from ChainAlert's state-poller/view-call.ts)
// ---------------------------------------------------------------------------

import {
  type Abi,
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
} from 'viem';

// Dynamic argument tokens supported in view-call rule configs
async function resolveViewCallArgs(
  args: unknown[],
  client: RpcClient,
): Promise<unknown[]> {
  return Promise.all(
    args.map(async (arg) => {
      if (typeof arg !== 'string') return arg;
      switch (arg) {
        case '$NOW':
          return BigInt(Math.floor(Date.now() / 1000));
        case '$BLOCK_NUMBER':
          return await client.getBlockNumber();
        case '$BLOCK_TIMESTAMP': {
          const blockNum = await client.getBlockNumber();
          const block = await client.getBlock(blockNum);
          return BigInt(block.timestamp);
        }
        default:
          return arg;
      }
    }),
  );
}

// Standard ABI base types recognised by viem's parseAbi.
// User-defined value types (Solidity UDVTs) must be replaced with uint256.
const KNOWN_ABI_TYPES = new Set([
  'address', 'bool', 'string', 'bytes', 'tuple', 'function', 'uint', 'int',
]);

function isKnownAbiType(t: string): boolean {
  if (KNOWN_ABI_TYPES.has(t)) return true;
  if (/^(u?int|bytes)\d+$/.test(t)) return true;
  if (t.endsWith(']')) return isKnownAbiType(t.replace(/\[.*\]$/, ''));
  return false;
}

/**
 * Replace user-defined value types in a Solidity function signature with
 * uint256, which is the correct ABI encoding for UDVTs.
 * e.g. "function foo(Timestamp ts) view returns (uint256)"
 *   →  "function foo(uint256 ts) view returns (uint256)"
 */
export function normaliseViewCallSignature(sig: string): string {
  return sig.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    const params = inner.split(',').map((p: string) => {
      const parts = p.trim().split(/\s+/);
      if (parts.length === 0) return p;
      const typeName = parts[0]!;
      const baseType = typeName.replace(/\[.*\]$/, '');
      if (!isKnownAbiType(typeName) && baseType !== '' && !isKnownAbiType(baseType)) {
        const arraySuffix = typeName.slice(baseType.length);
        parts[0] = `uint256${arraySuffix}`;
      }
      return parts.join(' ');
    });
    return `(${params.join(', ')})`;
  });
}

/**
 * Robustly parse view-call args from a rule config value.
 * Handles arrays, JSON strings, and bare $TOKEN references.
 */
export function parseViewCallArgs(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === '') return [];
  const str = String(raw);
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const fixed = str.replace(/(?<!")(\$[A-Z_]+)(?!")/g, '"$1"');
    try {
      const parsed = JSON.parse(fixed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      log.warn({ raw: str }, 'could not parse view-call args');
      return [];
    }
  }
}

function normaliseToBigInt(value: unknown, returnType: string): bigint {
  switch (returnType) {
    case 'bool':
      return value ? 1n : 0n;
    case 'address':
      return BigInt(value as string);
    default:
      return BigInt(value as bigint | number | string);
  }
}

/**
 * Encode, execute, and decode a view function call.
 * Handles dynamic arg tokens ($NOW, $BLOCK_NUMBER, $BLOCK_TIMESTAMP),
 * UDVT signature normalisation, and return-value decoding.
 * Returns the result normalised to bigint.
 */
export async function callViewFunction(
  client: RpcClient,
  contractAddress: string,
  functionSignature: string,
  args?: unknown[],
  returnType?: string,
): Promise<bigint> {
  if (!contractAddress) {
    throw new Error(`callViewFunction: contractAddress required`);
  }

  const safeSig = normaliseViewCallSignature(functionSignature);
  const abi = parseAbi([safeSig] as const) as unknown as Abi;
  const fnEntry = (abi as unknown as { type: string; name: string }[]).find(
    (item) => item.type === 'function',
  );
  if (!fnEntry) {
    throw new Error(`Could not parse function from signature: ${functionSignature}`);
  }
  const functionName = fnEntry.name;

  const parsedArgs = parseViewCallArgs(args);
  const resolvedArgs = await resolveViewCallArgs(parsedArgs, client);

  const data = encodeFunctionData({
    abi,
    functionName,
    args: resolvedArgs.length > 0 ? resolvedArgs : undefined,
  });

  const result = await client.call({ to: contractAddress as Address, data });

  if (!result || result === '0x') {
    throw new Error(`View call returned no data for ${functionName}() on ${contractAddress}`);
  }

  const decoded = decodeFunctionResult({
    abi,
    functionName,
    data: result as `0x${string}`,
  });

  return normaliseToBigInt(decoded, returnType ?? 'uint256');
}
