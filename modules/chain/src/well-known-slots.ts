export interface WellKnownSlot {
  slot: string;
  label: string;
  description: string;
  category: 'proxy' | 'access-control' | 'governance';
  decodeAs: 'address' | 'uint256' | 'bool';
}

export const WELL_KNOWN_SLOTS = {
  ERC1967_IMPLEMENTATION: {
    slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    label: 'ERC-1967 Implementation',
    description: 'Proxy implementation address slot',
    category: 'proxy' as const,
    decodeAs: 'address' as const,
  },
  ERC1967_ADMIN: {
    slot: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    label: 'ERC-1967 Admin',
    description: 'Proxy admin address slot',
    category: 'proxy' as const,
    decodeAs: 'address' as const,
  },
  ERC1967_BEACON: {
    slot: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
    label: 'ERC-1967 Beacon',
    description: 'Beacon proxy slot',
    category: 'proxy' as const,
    decodeAs: 'address' as const,
  },
  OZ_IMPLEMENTATION: {
    slot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
    label: 'OpenZeppelin Implementation (legacy)',
    description: 'Legacy OpenZeppelin proxy implementation slot',
    category: 'proxy' as const,
    decodeAs: 'address' as const,
  },
  CHAINLINK_AGGREGATOR: {
    slot: '0x5f3677657461676772656761746f720000000000000000000000000000000000',
    label: 'Chainlink Aggregator',
    description: 'Chainlink price feed aggregator slot',
    category: 'governance' as const,
    decodeAs: 'address' as const,
  },
} as const;

export function lookupSlot(hex: string): { label: string; description: string } | undefined {
  const normalized = hex.toLowerCase();
  return Object.values(WELL_KNOWN_SLOTS).find((s) => s.slot === normalized);
}

export function getSuggestedSlots(opts: { isProxy: boolean }): WellKnownSlot[] {
  if (!opts.isProxy) return [];
  return [
    WELL_KNOWN_SLOTS.ERC1967_IMPLEMENTATION,
    WELL_KNOWN_SLOTS.ERC1967_ADMIN,
    WELL_KNOWN_SLOTS.ERC1967_BEACON,
  ];
}
