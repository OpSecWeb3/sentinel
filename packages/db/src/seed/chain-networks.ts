import { chainNetworks } from '../../schema/chain.js';
import type { Db } from '../../index.js';

// rpcUrl is comma-separated — loadNetworkConfig() splits on ',' and createRpcClient()
// rotates across them hourly with automatic failover, matching ChainAlert's behaviour.
const KNOWN_NETWORKS = [
  {
    name: 'Ethereum Mainnet',
    slug: 'ethereum',
    chainKey: 'ethereum',
    chainId: 1,
    rpcUrl: 'https://cloudflare-eth.com,https://eth.llamarpc.com,https://rpc.ankr.com/eth',
    blockTimeMs: 12_000,
    explorerUrl: 'https://etherscan.io',
    explorerApi: 'https://api.etherscan.io/api',
    isActive: true,
  },
  {
    name: 'Polygon',
    slug: 'polygon',
    chainKey: 'polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com,https://rpc.ankr.com/polygon',
    blockTimeMs: 2_000,
    explorerUrl: 'https://polygonscan.com',
    explorerApi: 'https://api.polygonscan.com/api',
    isActive: true,
  },
  {
    name: 'Arbitrum One',
    slug: 'arbitrum',
    chainKey: 'arbitrum',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc,https://rpc.ankr.com/arbitrum',
    blockTimeMs: 250,
    explorerUrl: 'https://arbiscan.io',
    explorerApi: 'https://api.arbiscan.io/api',
    isActive: true,
  },
  {
    name: 'Optimism',
    slug: 'optimism',
    chainKey: 'optimism',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io,https://rpc.ankr.com/optimism',
    blockTimeMs: 2_000,
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerApi: 'https://api-optimistic.etherscan.io/api',
    isActive: true,
  },
  {
    name: 'Base',
    slug: 'base',
    chainKey: 'base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org,https://rpc.ankr.com/base',
    blockTimeMs: 2_000,
    explorerUrl: 'https://basescan.org',
    explorerApi: 'https://api.basescan.org/api',
    isActive: true,
  },
  {
    name: 'Ethereum Sepolia',
    slug: 'sepolia',
    chainKey: 'sepolia',
    chainId: 11155111,
    rpcUrl: 'https://rpc.sepolia.org,https://rpc.ankr.com/eth_sepolia',
    blockTimeMs: 12_000,
    explorerUrl: 'https://sepolia.etherscan.io',
    explorerApi: 'https://api-sepolia.etherscan.io/api',
    isActive: true,
  },
];

export async function seedChainNetworks(db: Db): Promise<void> {
  for (const network of KNOWN_NETWORKS) {
    await db.insert(chainNetworks).values(network).onConflictDoNothing();
  }
}
