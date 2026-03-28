import { getDb, closeDb } from '../index.js';
import { seedChainNetworks } from './seed/chain-networks.js';

async function main() {
  const db = getDb();
  await seedChainNetworks(db);
  console.log('Seed complete');
  await closeDb();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
