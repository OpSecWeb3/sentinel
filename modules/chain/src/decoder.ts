/**
 * ABI event/function decoder for the chain module.
 *
 * Uses viem to decode event logs and function calldata against known ABIs.
 * Provides well-known ABI fallbacks for common events (ERC-20 Transfer,
 * Approval, OwnershipTransferred) so monitoring works even without a
 * user-provided ABI.
 */
import {
  decodeEventLog,
  decodeFunctionData,
  parseAbi,
  type Abi,
  type AbiEvent,
} from 'viem';

// ---------------------------------------------------------------------------
// Well-known ABI fragments (fallback when no contract ABI is available)
// ---------------------------------------------------------------------------

const WELL_KNOWN_ABI = parseAbi([
  // ERC-20
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  // ERC-721
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  // Ownable
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  // Proxy / upgrade
  'event Upgraded(address indexed implementation)',
  'event AdminChanged(address previousAdmin, address newAdmin)',
  'event BeaconUpgraded(address indexed beacon)',
  // Pausable
  'event Paused(address account)',
  'event Unpaused(address account)',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
}

export interface DecodedFunctionCall {
  functionName: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event log decoder
// ---------------------------------------------------------------------------

/**
 * Attempt to decode a raw event log using the provided ABI(s).
 * Falls back to well-known ABIs if no contract ABI is provided or
 * if decoding fails with the provided ABI.
 *
 * Returns null if decoding fails entirely (unknown event).
 */
export function decodeLog(
  topics: string[],
  data: string,
  contractAbi?: unknown,
): DecodedLog | null {
  if (!topics.length) return null;

  // Build list of ABIs to try: contract ABI first, then well-known fallbacks
  const abisToTry: Abi[] = [];

  if (contractAbi) {
    const parsed = normalizeAbi(contractAbi);
    if (parsed) abisToTry.push(parsed);
  }

  abisToTry.push(WELL_KNOWN_ABI);

  for (const abi of abisToTry) {
    try {
      const decoded = decodeEventLog({
        abi,
        topics: topics as [`0x${string}`, ...`0x${string}`[]],
        data: data as `0x${string}`,
        strict: false,
      });

      if (decoded) {
        // Convert args from tuple/object to plain Record
        const args: Record<string, unknown> = {};
        if (decoded.args && typeof decoded.args === 'object') {
          for (const [key, value] of Object.entries(decoded.args as unknown as Record<string, unknown>)) {
            args[key] = typeof value === 'bigint' ? value.toString() : value;
          }
        }

        return {
          eventName: decoded.eventName ?? 'Unknown',
          args,
        };
      }
    } catch {
      // Decoding failed with this ABI, try next
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Function calldata decoder
// ---------------------------------------------------------------------------

/**
 * Attempt to decode function calldata using the provided ABI.
 * Returns null if decoding fails.
 */
export function decodeFunctionCallData(
  input: string,
  contractAbi?: unknown,
): DecodedFunctionCall | null {
  if (!input || input.length < 10) return null;

  const abi = normalizeAbi(contractAbi);
  if (!abi) return null;

  try {
    const decoded = decodeFunctionData({
      abi,
      data: input as `0x${string}`,
    });

    if (decoded) {
      const args: Record<string, unknown> = {};
      if (decoded.args) {
        const argsArray = decoded.args as unknown[];
        // viem returns args as a tuple; try to map them to named params
        // by matching against the ABI function definition
        const fnAbi = abi.find(
          (item) => item.type === 'function' && item.name === decoded.functionName,
        );
        if (fnAbi && 'inputs' in fnAbi && fnAbi.inputs) {
          for (let i = 0; i < fnAbi.inputs.length; i++) {
            const name = fnAbi.inputs[i]?.name ?? String(i);
            const val = argsArray[i];
            args[name] = typeof val === 'bigint' ? val.toString() : val;
          }
        } else {
          for (let i = 0; i < argsArray.length; i++) {
            const val = argsArray[i];
            args[String(i)] = typeof val === 'bigint' ? val.toString() : val;
          }
        }
      }

      return {
        functionName: decoded.functionName,
        args,
      };
    }
  } catch {
    // Decoding failed
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an ABI value into a viem-compatible Abi type.
 * Handles: Abi arrays, JSON strings, objects with an `abi` property.
 */
function normalizeAbi(abi: unknown): Abi | null {
  if (!abi) return null;

  // Already an array (standard ABI format)
  if (Array.isArray(abi)) {
    if (abi.length === 0) return null;
    return abi as Abi;
  }

  // JSON string
  if (typeof abi === 'string') {
    try {
      const parsed = JSON.parse(abi);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as Abi;
    } catch {
      return null;
    }
  }

  // Object with an `abi` property (e.g., Hardhat artifact)
  if (typeof abi === 'object' && abi !== null && 'abi' in abi) {
    return normalizeAbi((abi as { abi: unknown }).abi);
  }

  return null;
}
