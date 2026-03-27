import type { EventTypeDefinition } from '@sentinel/shared/module';

export const eventTypes: EventTypeDefinition[] = [
  // ── On-chain event matching ────────────────────────────────────────────
  {
    type: 'chain.event.matched',
    label: 'On-chain event matched',
    description: 'An on-chain log event matched a detection rule (event signature + field conditions)',
  },
  {
    type: 'chain.event.large_transfer',
    label: 'Large transfer detected',
    description: 'A token or native asset transfer exceeded the configured threshold',
  },
  {
    type: 'chain.event.contract_created',
    label: 'Contract deployment detected',
    description: 'A new contract was deployed (transaction with null `to` address)',
  },

  // ── State monitoring ───────────────────────────────────────────────────
  {
    type: 'chain.state.balance_change',
    label: 'Significant balance change',
    description: 'A monitored address balance changed beyond the configured threshold or percentage',
  },
  {
    type: 'chain.state.storage_change',
    label: 'Storage slot changed',
    description: 'An EVM storage slot value changed or crossed a configured threshold',
  },
  {
    type: 'chain.state.view_call_change',
    label: 'View function return changed',
    description: 'A view/pure function return value changed or crossed a configured threshold',
  },

  // ── Compound / behavioural patterns ────────────────────────────────────
  {
    type: 'chain.event.fund_drainage',
    label: 'Fund drainage pattern',
    description: 'A large outflow pattern was detected (significant balance drop within a time window)',
  },
  {
    type: 'chain.event.ownership_change',
    label: 'Ownership transferred',
    description: 'Contract ownership was transferred (OwnershipTransferred / OwnershipTransferStarted)',
  },

  // ── Infrastructure ─────────────────────────────────────────────────────
  {
    type: 'chain.block.reorg',
    label: 'Chain reorganization',
    description: 'A chain reorganization was detected (block at a previously-seen height has a different hash)',
  },
];
