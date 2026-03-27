/**
 * Contract trait detection via ABI signature matching.
 *
 * Analyzes a contract's ABI to detect well-known interfaces (ERC-20, ERC-721,
 * Ownable, etc.) by checking for required function selectors and event topic0s.
 */
import {
  toFunctionSelector,
  toEventSelector,
  type Abi,
  type AbiFunction,
  type AbiEvent,
} from 'viem';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractTrait {
  id: string;
  name: string;
  confidence: number;
}

interface TraitDefinition {
  id: string;
  name: string;
  requiredFunctions: string[];
  requiredEvents: string[];
  optionalFunctions?: string[];
  optionalEvents?: string[];
}

// ---------------------------------------------------------------------------
// Trait definitions
// ---------------------------------------------------------------------------

const TRAIT_DEFINITIONS: TraitDefinition[] = [
  {
    id: 'erc20',
    name: 'ERC-20 Token',
    requiredFunctions: [
      toFunctionSelector('function transfer(address,uint256)'),
      toFunctionSelector('function approve(address,uint256)'),
      toFunctionSelector('function transferFrom(address,address,uint256)'),
      toFunctionSelector('function balanceOf(address)'),
      toFunctionSelector('function totalSupply()'),
      toFunctionSelector('function allowance(address,address)'),
    ],
    requiredEvents: [
      toEventSelector('event Transfer(address indexed, address indexed, uint256)'),
      toEventSelector('event Approval(address indexed, address indexed, uint256)'),
    ],
    optionalFunctions: [
      toFunctionSelector('function name()'),
      toFunctionSelector('function symbol()'),
      toFunctionSelector('function decimals()'),
    ],
  },
  {
    id: 'erc721',
    name: 'ERC-721 NFT',
    requiredFunctions: [
      toFunctionSelector('function balanceOf(address)'),
      toFunctionSelector('function ownerOf(uint256)'),
      toFunctionSelector('function safeTransferFrom(address,address,uint256)'),
      toFunctionSelector('function transferFrom(address,address,uint256)'),
      toFunctionSelector('function approve(address,uint256)'),
      toFunctionSelector('function setApprovalForAll(address,bool)'),
      toFunctionSelector('function getApproved(uint256)'),
      toFunctionSelector('function isApprovedForAll(address,address)'),
    ],
    requiredEvents: [
      toEventSelector('event Transfer(address indexed, address indexed, uint256 indexed)'),
      toEventSelector('event Approval(address indexed, address indexed, uint256 indexed)'),
      toEventSelector('event ApprovalForAll(address indexed, address indexed, bool)'),
    ],
    optionalFunctions: [
      toFunctionSelector('function tokenURI(uint256)'),
      toFunctionSelector('function supportsInterface(bytes4)'),
    ],
  },
  {
    id: 'ownable',
    name: 'Ownable',
    requiredFunctions: [
      toFunctionSelector('function owner()'),
      toFunctionSelector('function transferOwnership(address)'),
    ],
    requiredEvents: [
      toEventSelector('event OwnershipTransferred(address indexed, address indexed)'),
    ],
    optionalFunctions: [
      toFunctionSelector('function renounceOwnership()'),
    ],
  },
  {
    id: 'pausable',
    name: 'Pausable',
    requiredFunctions: [
      toFunctionSelector('function paused()'),
    ],
    requiredEvents: [
      toEventSelector('event Paused(address)'),
      toEventSelector('event Unpaused(address)'),
    ],
  },
  {
    id: 'upgradeable',
    name: 'Upgradeable Proxy',
    requiredFunctions: [],
    requiredEvents: [
      toEventSelector('event Upgraded(address indexed)'),
    ],
    optionalEvents: [
      toEventSelector('event AdminChanged(address, address)'),
      toEventSelector('event BeaconUpgraded(address indexed)'),
    ],
    optionalFunctions: [
      toFunctionSelector('function upgradeTo(address)'),
      toFunctionSelector('function upgradeToAndCall(address,bytes)'),
    ],
  },
  {
    id: 'access-control',
    name: 'Access Control',
    requiredFunctions: [
      toFunctionSelector('function hasRole(bytes32,address)'),
      toFunctionSelector('function getRoleAdmin(bytes32)'),
      toFunctionSelector('function grantRole(bytes32,address)'),
      toFunctionSelector('function revokeRole(bytes32,address)'),
    ],
    requiredEvents: [
      toEventSelector('event RoleGranted(bytes32 indexed, address indexed, address indexed)'),
      toEventSelector('event RoleRevoked(bytes32 indexed, address indexed, address indexed)'),
    ],
  },
];

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

function extractSelectors(abi: unknown[]): { functions: Set<string>; events: Set<string> } {
  const functions = new Set<string>();
  const events = new Set<string>();

  for (const item of abi) {
    const entry = item as { type?: string; name?: string; inputs?: unknown[] };
    if (!entry || typeof entry !== 'object' || !entry.type) continue;

    try {
      if (entry.type === 'function') {
        const selector = toFunctionSelector(item as AbiFunction);
        functions.add(selector);
      } else if (entry.type === 'event') {
        const topic0 = toEventSelector(item as AbiEvent);
        events.add(topic0);
      }
    } catch {
      // Skip malformed ABI entries
    }
  }

  return { functions, events };
}

/**
 * Detect contract traits by matching ABI function/event signatures against
 * well-known interface definitions.
 *
 * Returns traits where ALL required signatures match, sorted by confidence.
 */
export function detectTraits(abi: unknown[]): ContractTrait[] {
  if (!abi || !Array.isArray(abi) || abi.length === 0) return [];

  const { functions, events } = extractSelectors(abi);
  const traits: ContractTrait[] = [];

  for (const def of TRAIT_DEFINITIONS) {
    const reqFnTotal = def.requiredFunctions.length;
    const reqEvTotal = def.requiredEvents.length;
    const totalRequired = reqFnTotal + reqEvTotal;

    // Skip traits with no requirements (shouldn't happen, but defensive)
    if (totalRequired === 0) continue;

    const reqFnMatched = def.requiredFunctions.filter((s) => functions.has(s)).length;
    const reqEvMatched = def.requiredEvents.filter((s) => events.has(s)).length;

    // All required must match
    if (reqFnMatched < reqFnTotal || reqEvMatched < reqEvTotal) continue;

    // Compute confidence with optional bonus
    const optFn = def.optionalFunctions ?? [];
    const optEv = def.optionalEvents ?? [];
    const optFnMatched = optFn.filter((s) => functions.has(s)).length;
    const optEvMatched = optEv.filter((s) => events.has(s)).length;

    const optTotal = optFn.length + optEv.length;
    const optMatched = optFnMatched + optEvMatched;

    // Base confidence is 1.0 for all required matched; optional adds up to 0.0 extra
    // (confidence ranges from requiredWeight to 1.0)
    const confidence = optTotal > 0
      ? 0.8 + 0.2 * (optMatched / optTotal)
      : 1.0;

    traits.push({
      id: def.id,
      name: def.name,
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  return traits.sort((a, b) => b.confidence - a.confidence);
}
