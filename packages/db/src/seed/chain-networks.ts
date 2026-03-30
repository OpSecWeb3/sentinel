import { chainNetworks } from '../../schema/chain.js';
import type { Db } from '../../index.js';

// rpcUrl is comma-separated — loadNetworkConfig() splits on ',' and createRpcClient()
// rotates across them hourly with automatic failover, matching ChainAlert's behaviour.
//
// Product default: mainnet only in the UI (`is_active` gates GET /networks). Sepolia is
// seeded inactive so it can be enabled in DB for testing without appearing for normal users.
// Other EVM chains can still be added manually to `chain_networks` if needed.
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
    name: 'Ethereum Sepolia',
    slug: 'sepolia',
    chainKey: 'sepolia',
    chainId: 11155111,
    rpcUrl: 'https://rpc.sepolia.org,https://rpc.ankr.com/eth_sepolia',
    blockTimeMs: 12_000,
    explorerUrl: 'https://sepolia.etherscan.io',
    explorerApi: 'https://api-sepolia.etherscan.io/api',
    isActive: false,
  },
] as const;

export async function seedChainNetworks(db: Db): Promise<void> {
  for (const network of KNOWN_NETWORKS) {
    await db
      .insert(chainNetworks)
      .values(network)
      .onConflictDoUpdate({
        target: chainNetworks.slug,
        set: {
          name: network.name,
          chainKey: network.chainKey,
          chainId: network.chainId,
          rpcUrl: network.rpcUrl,
          blockTimeMs: network.blockTimeMs,
          explorerUrl: network.explorerUrl,
          explorerApi: network.explorerApi,
          isActive: network.isActive,
        },
      });
  }
}
