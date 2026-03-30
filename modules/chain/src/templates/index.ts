import type { DetectionTemplate } from '@sentinel/shared/module';
import { WELL_KNOWN_SLOTS } from '../well-known-slots.js';

const CONDITION_TYPE_OPTIONS = [
  { value: 'changed', label: 'Any change' },
  { value: 'equals', label: 'Equals value' },
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'percent_change', label: 'Changes by %' },
];

const FILTER_OP_OPTIONS = [
  { value: '==', label: '==' },
  { value: '!=', label: '!=' },
  { value: '>', label: '>' },
  { value: '>=', label: '>=' },
  { value: '<', label: '<' },
  { value: '<=', label: '<=' },
];

const NETWORK_INPUT = {
  key: 'networkId',
  label: 'Network',
  type: 'network' as const,
  required: true,
};

const CONTRACT_REQUIRED_INPUT = {
  key: 'contractAddress',
  label: 'Contract',
  type: 'contract' as const,
  required: true,
  help: 'Select a monitored contract or paste an address directly.',
};

export const templates: DetectionTemplate[] = [
  // ── Token Activity ─────────────────────────────────────────────────────
  {
    slug: 'chain-large-transfer',
    name: 'Large Transfer Monitor',
    description:
      'Alert when an ERC-20 Transfer event moves more than a specified amount of tokens. Catches whale movements and potential exploits.',
    category: 'token-activity',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'threshold',
        label: 'Transfer threshold',
        type: 'number',
        required: true,
        placeholder: '1000000000000000000',
        help: 'Minimum token amount in base units (e.g. 1e18 = 1 token with 18 decimals).',
        min: 1,
      },
    ],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'Transfer(address,address,uint256)',
          eventName: 'Transfer',
          conditions: [
            { field: 'value', operator: '>', value: '{{threshold}}' },
          ],
        },
        action: 'alert',
      },
    ],
  },

  // ── Balance / Drainage ─────────────────────────────────────────────────
  {
    slug: 'chain-fund-drainage',
    name: 'Fund Drainage Detection',
    description:
      'Alert when the native or token balance of a contract drops by a specified percentage within a time window. Detects hacks, rug pulls, and unexpected outflows.',
    category: 'balance',
    severity: 'critical',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'windowMinutes',
        label: 'Time window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'countThreshold',
        label: 'Transfer count threshold',
        type: 'number',
        required: true,
        default: 10,
        min: 1,
        help: 'Number of transfers within the window before alerting.',
      },
      {
        key: 'tokenAddress',
        label: 'Token address',
        type: 'address',
        required: false,
        placeholder: '0x...',
        help: 'ERC-20 token to track. Leave empty to track native ETH/MATIC balance.',
      },
      {
        key: 'dropPercent',
        label: 'Balance drop % to alert',
        type: 'number',
        required: true,
        default: 20,
        min: 1,
        max: 100,
        help: 'Alert when balance drops by this percentage within the window.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.windowed_count',
        config: {
          eventSignature: 'Transfer(address,address,uint256)',
          eventName: 'Transfer',
          groupByField: 'to',
          windowMinutes: '{{windowMinutes}}',
          condition: { op: '>=', value: '{{countThreshold}}' },
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'chain.balance_track',
        config: {
          asset: '{{tokenAddress}}',
          windowMinutes: '{{windowMinutes}}',
          condition: {
            type: 'percent_change',
            value: '{{dropPercent}}',
          },
        },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── Governance ─────────────────────────────────────────────────────────
  {
    slug: 'chain-ownership-monitor',
    name: 'Contract Ownership Monitor',
    description:
      'Alert when ownership of a contract is transferred or a transfer is initiated. Covers OpenZeppelin Ownable and Ownable2Step patterns.',
    category: 'governance',
    severity: 'critical',
    inputs: [NETWORK_INPUT, CONTRACT_REQUIRED_INPUT],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'OwnershipTransferred(address,address)',
          eventName: 'OwnershipTransferred',
        },
        action: 'alert',
      },
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'OwnershipTransferStarted(address,address)',
          eventName: 'OwnershipTransferStarted',
        },
        action: 'alert',
      },
    ],
  },

  // ── State Monitoring ───────────────────────────────────────────────────
  {
    slug: 'chain-storage-anomaly',
    name: 'Storage Anomaly Detector',
    description:
      'Monitor an EVM storage slot for unexpected changes or threshold crossings. Useful for detecting proxy upgrades, parameter manipulation, and silent contract changes.',
    category: 'governance',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'slot',
        label: 'Storage slot',
        type: 'text',
        required: true,
        placeholder: '0x0',
        help: 'Hex-encoded storage slot index (e.g. 0x0 for slot 0, 0x1 for slot 1).',
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        required: false,
        default: 60000,
        min: 10000,
        help: 'How often to read the storage slot.',
      },
      {
        key: 'conditionType',
        label: 'Alert condition',
        type: 'select',
        required: true,
        default: 'changed',
        options: CONDITION_TYPE_OPTIONS,
      },
      {
        key: 'conditionValue',
        label: 'Condition value',
        type: 'text',
        required: false,
        showIf: 'conditionType',
        placeholder: '0',
        help: 'Value to compare against (not needed for "any change").',
      },
    ],
    rules: [
      {
        ruleType: 'chain.state_poll',
        config: {
          slot: '{{slot}}',
          pollIntervalMs: '{{pollIntervalMs}}',
          condition: {
            type: '{{conditionType}}',
            value: '{{conditionValue}}',
          },
        },
        action: 'alert',
      },
    ],
  },

  // ── Contract Creation ──────────────────────────────────────────────────
  {
    slug: 'chain-contract-creation',
    name: 'Contract Creation Watcher',
    description:
      'Alert when a new contract is deployed by a monitored address. Catches factory deployments and unexpected contract creation.',
    category: 'contract-activity',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      {
        key: 'watchAddress',
        label: 'Watch address',
        type: 'address',
        required: true,
        placeholder: '0x...',
        help: 'Alert when this address deploys a new contract.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          matchContractCreation: true,
          fromAddress: '{{watchAddress}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Balance Low ─────────────────────────────────────────────────────────
  {
    slug: 'chain-balance-low',
    name: 'Balance Low Alert',
    description:
      'Alert when the native or token balance of an address falls below a minimum threshold. Useful for ensuring operational wallets, relayers, and treasury contracts maintain minimum liquidity.',
    category: 'balance',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, label: 'Address to monitor', help: 'Address whose balance to watch.' },
      {
        key: 'tokenAddress',
        label: 'Token address',
        type: 'address',
        required: false,
        placeholder: '0x...',
        help: 'ERC-20 token to track. Leave empty for native ETH/MATIC balance.',
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        required: false,
        default: 60000,
        min: 10000,
      },
      {
        key: 'threshold',
        label: 'Minimum balance',
        type: 'text',
        required: true,
        placeholder: '1000000000000000000',
        help: 'Alert when balance drops below this amount (in base units, e.g. wei).',
      },
    ],
    rules: [
      {
        ruleType: 'chain.balance_track',
        config: {
          asset: '{{tokenAddress}}',
          pollIntervalMs: '{{pollIntervalMs}}',
          condition: {
            type: 'threshold_below',
            value: '{{threshold}}',
          },
        },
        action: 'alert',
      },
    ],
  },

  // ── Custom Function Call ────────────────────────────────────────────────
  {
    slug: 'chain-custom-function-call',
    name: 'Custom Function Call Monitor',
    description:
      'Alert when a specific function is called on a contract by matching the 4-byte selector in transaction calldata. Useful for detecting admin functions, parameter changes, and operations that emit no events.',
    category: 'custom',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'functionSignature',
        label: 'Function signature',
        type: 'text',
        required: true,
        placeholder: 'transfer(address,uint256)',
        help: 'Solidity function signature to match (e.g. setFee(uint256), pause()).',
      },
      {
        key: 'functionName',
        label: 'Function name',
        type: 'text',
        required: false,
        placeholder: 'transfer',
        help: 'Human-readable function name for display.',
      },
      {
        key: 'filterField',
        label: 'Filter field (optional)',
        type: 'text',
        required: false,
        placeholder: 'amount',
        help: 'Decoded function argument to filter on. Leave empty to match all calls.',
      },
      {
        key: 'filterOp',
        label: 'Operator',
        type: 'select',
        required: false,
        showIf: 'filterField',
        options: FILTER_OP_OPTIONS,
      },
      {
        key: 'filterValue',
        label: 'Filter value',
        type: 'text',
        required: false,
        showIf: 'filterField',
        placeholder: '0',
      },
    ],
    rules: [
      {
        ruleType: 'chain.function_call_match',
        config: {
          functionSignature: '{{functionSignature}}',
          functionName: '{{functionName}}',
          contractAddress: '{{contractAddress}}',
          conditions: [
            {
              field: '{{filterField}}',
              operator: '{{filterOp}}',
              value: '{{filterValue}}',
              skipIfEmpty: true,
            },
          ],
        },
        action: 'alert',
      },
    ],
  },

  // ── Custom ─────────────────────────────────────────────────────────────
  {
    slug: 'chain-custom-event',
    name: 'Custom Event Monitor',
    description:
      'Watch for any on-chain event by providing its Solidity signature. Optionally filter on decoded parameters.',
    category: 'custom',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'eventSignature',
        label: 'Event signature',
        type: 'text',
        required: true,
        placeholder: 'Transfer(address,address,uint256)',
        help: 'Full Solidity event signature (e.g. Transfer(address,address,uint256)).',
      },
      {
        key: 'eventName',
        label: 'Event name',
        type: 'text',
        required: false,
        placeholder: 'Transfer',
        help: 'Human-readable event name for display purposes.',
      },
      {
        key: 'filterField',
        label: 'Filter field (optional)',
        type: 'text',
        required: false,
        placeholder: 'from',
        help: 'Decoded event parameter to filter on. Leave empty to match all events.',
      },
      {
        key: 'filterOp',
        label: 'Operator',
        type: 'select',
        required: false,
        showIf: 'filterField',
        options: FILTER_OP_OPTIONS,
      },
      {
        key: 'filterValue',
        label: 'Filter value',
        type: 'text',
        required: false,
        showIf: 'filterField',
        placeholder: '0x...',
      },
    ],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: '{{eventSignature}}',
          eventName: '{{eventName}}',
          conditions: [
            {
              field: '{{filterField}}',
              operator: '{{filterOp}}',
              value: '{{filterValue}}',
              skipIfEmpty: true,
            },
          ],
        },
        action: 'alert',
      },
    ],
  },

  // ── Balance Tracker ────────────────────────────────────────────────────
  {
    slug: 'chain-balance-tracker',
    name: 'Balance Tracker',
    description:
      'Monitor the native or token balance of an address and alert when it falls below a minimum, exceeds a maximum, or changes by a configurable percentage.',
    category: 'balance',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, label: 'Address to monitor', help: 'Address whose balance to track.' },
      {
        key: 'tokenAddress',
        label: 'Token address',
        type: 'address',
        required: false,
        placeholder: '0x...',
        help: 'ERC-20 token to track. Leave empty for native ETH/MATIC balance.',
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        required: false,
        default: 60000,
        min: 10000,
      },
      {
        key: 'windowMinutes',
        label: 'Window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'conditionType',
        label: 'Alert when balance',
        type: 'select',
        required: true,
        default: 'percent_change',
        options: [
          { value: 'min', label: 'Falls below minimum' },
          { value: 'max', label: 'Exceeds maximum' },
          { value: 'percent_change', label: 'Changes by %' },
        ],
      },
      {
        key: 'conditionValue',
        label: 'Threshold',
        type: 'number',
        required: true,
        placeholder: '20',
        help: 'Amount (for min/max) or percentage (for percent change).',
        min: 0,
      },
      {
        key: 'bidirectional',
        label: 'Alert on both increase and decrease',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
    rules: [
      {
        ruleType: 'chain.balance_track',
        config: {
          asset: '{{tokenAddress}}',
          pollIntervalMs: '{{pollIntervalMs}}',
          windowMinutes: '{{windowMinutes}}',
          condition: {
            type: '{{conditionType}}',
            value: '{{conditionValue}}',
            bidirectional: '{{bidirectional}}',
          },
        },
        action: 'alert',
      },
    ],
  },

  // ── Activity Spike ─────────────────────────────────────────────────────
  {
    slug: 'chain-activity-spike',
    name: 'Activity Spike Detector',
    description:
      'Alert when the firing rate of any event increases dramatically compared to a baseline period. Detects unusual bursts of activity that may signal an attack.',
    category: 'custom',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'eventSignature',
        label: 'Event signature',
        type: 'text',
        required: true,
        placeholder: 'Transfer(address,address,uint256)',
      },
      {
        key: 'eventName',
        label: 'Event name',
        type: 'text',
        required: false,
        placeholder: 'Transfer',
      },
      {
        key: 'groupByField',
        label: 'Group by field',
        type: 'text',
        required: false,
        placeholder: 'to',
        help: 'Count spikes per unique value of this decoded parameter.',
      },
      {
        key: 'observationMinutes',
        label: 'Observation window (minutes)',
        type: 'number',
        required: true,
        default: 5,
        min: 1,
        help: 'Recent window to compare against baseline.',
      },
      {
        key: 'baselineMinutes',
        label: 'Baseline window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 5,
        help: 'Historical window used as the normal baseline.',
      },
      {
        key: 'increasePercent',
        label: 'Spike threshold (%)',
        type: 'number',
        required: true,
        default: 300,
        min: 10,
        help: 'Alert when rate increases by this percentage above baseline.',
      },
      {
        key: 'minBaselineCount',
        label: 'Minimum baseline events',
        type: 'number',
        required: false,
        default: 1,
        min: 0,
        help: 'Minimum baseline events required before spike detection activates.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.windowed_spike',
        config: {
          eventSignature: '{{eventSignature}}',
          eventName: '{{eventName}}',
          groupByField: '{{groupByField}}',
          observationMinutes: '{{observationMinutes}}',
          baselineMinutes: '{{baselineMinutes}}',
          increasePercent: '{{increasePercent}}',
          minBaselineCount: '{{minBaselineCount}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Role Changes ──────────────────────────────────────────────────────
  {
    slug: 'chain-role-change',
    name: 'Access-Control Role Change',
    description:
      'Alert when an AccessControl role is granted or revoked on a contract. Detects privilege escalation and unexpected permission changes.',
    category: 'governance',
    severity: 'high',
    inputs: [NETWORK_INPUT, CONTRACT_REQUIRED_INPUT],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'RoleGranted(bytes32,address,address)',
          eventName: 'RoleGranted',
        },
        action: 'alert',
      },
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'RoleRevoked(bytes32,address,address)',
          eventName: 'RoleRevoked',
        },
        action: 'alert',
      },
    ],
  },

  // ── Proxy Upgrade (Event) ────────────────────────────────────────────
  {
    slug: 'chain-proxy-upgrade',
    name: 'Proxy Upgrade Monitor',
    description:
      'Alert when an ERC-1967 Upgraded event is emitted. Catches proxy implementation changes that could alter contract logic.',
    category: 'governance',
    severity: 'critical',
    inputs: [NETWORK_INPUT, { ...CONTRACT_REQUIRED_INPUT, help: 'The proxy contract to monitor.' }],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'Upgraded(address)',
          eventName: 'Upgraded',
        },
        action: 'alert',
      },
    ],
  },

  // ── Proxy Upgrade (Storage Slot) ─────────────────────────────────────
  {
    slug: 'chain-proxy-upgrade-slot',
    name: 'Proxy Upgrade Slot Watcher',
    description:
      'Poll the ERC-1967 implementation storage slot for changes. Detects proxy upgrades even when events are suppressed or non-standard.',
    category: 'governance',
    severity: 'critical',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, help: 'The proxy contract to monitor.' },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        required: false,
        default: 60000,
        min: 10000,
        help: 'How often to read the implementation slot.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.state_poll',
        config: {
          slot: WELL_KNOWN_SLOTS.ERC1967_IMPLEMENTATION.slot,
          pollIntervalMs: '{{pollIntervalMs}}',
          condition: { type: 'changed' },
        },
        action: 'alert',
      },
    ],
  },

  // ── Multisig Signer Changes ──────────────────────────────────────────
  {
    slug: 'chain-multisig-signer',
    name: 'Multisig Signer Change',
    description:
      'Alert when owners are added to or removed from a multisig wallet such as Safe (Gnosis Safe). Catches unauthorized signer modifications.',
    category: 'governance',
    severity: 'high',
    inputs: [NETWORK_INPUT, CONTRACT_REQUIRED_INPUT],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'AddedOwner(address)',
          eventName: 'AddedOwner',
        },
        action: 'alert',
      },
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'RemovedOwner(address)',
          eventName: 'RemovedOwner',
        },
        action: 'alert',
      },
    ],
  },

  // ── Pause / Unpause ──────────────────────────────────────────────────
  {
    slug: 'chain-pause-state',
    name: 'Pause State Monitor',
    description:
      'Alert when a contract is paused or unpaused. Detects emergency halts and unexpected protocol freezes that may indicate an incident.',
    category: 'governance',
    severity: 'high',
    inputs: [NETWORK_INPUT, CONTRACT_REQUIRED_INPUT],
    rules: [
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'Paused(address)',
          eventName: 'Paused',
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'chain.event_match',
        config: {
          eventSignature: 'Unpaused(address)',
          eventName: 'Unpaused',
        },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── Repeated Transfer ────────────────────────────────────────────────
  {
    slug: 'chain-repeated-transfer',
    name: 'Repeated Transfer Detector',
    description:
      'Alert when the same recipient receives more than a threshold number of transfers within a time window. Identifies wash trading, drip attacks, and automated drains.',
    category: 'token-activity',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, label: 'Token contract' },
      {
        key: 'windowMinutes',
        label: 'Time window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'threshold',
        label: 'Transfer count threshold',
        type: 'number',
        required: true,
        default: 10,
        min: 1,
        help: 'Alert when a single recipient receives this many transfers within the window.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.windowed_count',
        config: {
          eventSignature: 'Transfer(address,address,uint256)',
          eventName: 'Transfer',
          groupByField: 'to',
          windowMinutes: '{{windowMinutes}}',
          threshold: '{{threshold}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Native Balance Anomaly ───────────────────────────────────────────
  {
    slug: 'chain-native-balance-anomaly',
    name: 'Native Balance Anomaly',
    description:
      'Alert when the native (ETH/MATIC/etc.) balance of a monitored address drops by a configurable percentage within a time window. Detects unexpected outflows and potential key compromise.',
    category: 'balance',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, label: 'Address to monitor', help: 'Address whose native balance to watch.' },
      {
        key: 'windowMinutes',
        label: 'Time window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'dropPercent',
        label: 'Balance drop % to alert',
        type: 'number',
        required: true,
        default: 20,
        min: 1,
        max: 100,
      },
    ],
    rules: [
      {
        ruleType: 'chain.balance_track',
        config: {
          asset: 'native',
          windowMinutes: '{{windowMinutes}}',
          condition: {
            type: 'percent_change',
            value: '{{dropPercent}}',
          },
        },
        action: 'alert',
      },
    ],
  },

  // ── Custom Storage Slot ──────────────────────────────────────────────
  {
    slug: 'chain-custom-storage-slot',
    name: 'Custom Storage Slot Monitor',
    description:
      'Poll an arbitrary EVM storage slot and alert when its value matches a user-defined condition. Enables low-level state monitoring for any contract.',
    category: 'custom',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'slot',
        label: 'Storage slot',
        type: 'text',
        required: true,
        placeholder: '0x0',
        help: 'Hex-encoded slot index (e.g. 0x0, 0x1, 0x360894...).',
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        required: false,
        default: 60000,
        min: 10000,
      },
      {
        key: 'conditionType',
        label: 'Alert condition',
        type: 'select',
        required: true,
        default: 'changed',
        options: CONDITION_TYPE_OPTIONS,
      },
      {
        key: 'conditionValue',
        label: 'Condition value',
        type: 'text',
        required: false,
        showIf: 'conditionType',
        placeholder: '0',
      },
    ],
    rules: [
      {
        ruleType: 'chain.state_poll',
        config: {
          slot: '{{slot}}',
          pollIntervalMs: '{{pollIntervalMs}}',
          condition: {
            type: '{{conditionType}}',
            value: '{{conditionValue}}',
          },
        },
        action: 'alert',
      },
    ],
  },

  // ── Custom View Function ─────────────────────────────────────────────
  {
    slug: 'chain-custom-view-function',
    name: 'Custom View Function Monitor',
    description:
      'Call a read-only contract function on a schedule and alert when the returned value satisfies a condition. Useful for monitoring protocol parameters, oracle prices, and governance state.',
    category: 'custom',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'functionSignature',
        label: 'Function signature',
        type: 'text',
        required: true,
        placeholder: 'balanceOf(address)',
        help: 'Read-only function to call periodically (must be view/pure).',
      },
      {
        key: 'resultField',
        label: 'Result field',
        type: 'text',
        required: false,
        default: 'result',
        placeholder: '0',
        help: 'Index or name of the return value to evaluate (0 for first).',
      },
      {
        key: 'filterField',
        label: 'Filter field (optional)',
        type: 'text',
        required: false,
        placeholder: '0',
        help: 'Return value index to compare.',
      },
      {
        key: 'filterOp',
        label: 'Operator',
        type: 'select',
        required: false,
        showIf: 'filterField',
        options: FILTER_OP_OPTIONS,
      },
      {
        key: 'filterValue',
        label: 'Compare value',
        type: 'text',
        required: false,
        showIf: 'filterField',
        placeholder: '0',
      },
    ],
    rules: [
      {
        ruleType: 'chain.view_call',
        config: {
          functionSignature: '{{functionSignature}}',
          resultField: '{{resultField}}',
          conditions: [
            {
              field: '{{filterField}}',
              operator: '{{filterOp}}',
              value: '{{filterValue}}',
              skipIfEmpty: true,
            },
          ],
        },
        action: 'alert',
      },
    ],
  },

  // ── Custom Windowed Count ────────────────────────────────────────────
  {
    slug: 'chain-custom-windowed-count',
    name: 'Custom Windowed Event Count',
    description:
      'Count occurrences of any on-chain event within a sliding time window and alert when the count exceeds a threshold. Supports grouping by a decoded field for per-entity counting.',
    category: 'custom',
    severity: 'medium',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'eventSignature',
        label: 'Event signature',
        type: 'text',
        required: true,
        placeholder: 'Transfer(address,address,uint256)',
      },
      {
        key: 'eventName',
        label: 'Event name',
        type: 'text',
        required: false,
        placeholder: 'Transfer',
      },
      {
        key: 'groupByField',
        label: 'Group by field (optional)',
        type: 'text',
        required: false,
        placeholder: 'to',
        help: 'Count per unique value of this decoded parameter.',
      },
      {
        key: 'windowMinutes',
        label: 'Time window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'threshold',
        label: 'Count threshold',
        type: 'number',
        required: true,
        default: 10,
        min: 1,
        help: 'Alert when event count exceeds this value within the window.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.windowed_count',
        config: {
          eventSignature: '{{eventSignature}}',
          eventName: '{{eventName}}',
          groupByField: '{{groupByField}}',
          windowMinutes: '{{windowMinutes}}',
          threshold: '{{threshold}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── View Call Change — time-based ───────────────────────────────────
  {
    slug: 'chain-view-call-time-change',
    name: 'View Call Time-Window Change Monitor',
    description:
      'Call a read-only contract function on a schedule and alert when its return value shifts by a configurable percentage relative to a rolling time-based baseline. ' +
      'Use this when you reason in wall-clock terms: "did this value change by more than X% in the last 5 minutes compared to the past hour?" ' +
      'Good for oracle prices, protocol parameters, and any numeric state that has a natural time horizon.',
    category: 'custom',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'functionSignature',
        label: 'View function signature',
        type: 'text',
        required: true,
        placeholder: 'totalSupply()',
        help: 'Read-only (view/pure) function to call periodically. Use the full Solidity signature, e.g. balanceOf(address).',
      },
      {
        key: 'resultField',
        label: 'Result field',
        type: 'text',
        required: false,
        default: 'result',
        placeholder: 'result',
        help: 'Return value key to track. Leave as "result" for single-return functions, or use the named output parameter for multi-return functions.',
      },
      {
        key: 'observationMinutes',
        label: 'Observation window (min)',
        type: 'number',
        required: true,
        default: 5,
        min: 1,
        help: 'Recent time window whose average is compared against the baseline. Keep this shorter than the baseline window.',
      },
      {
        key: 'baselineMinutes',
        label: 'Baseline window (min)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
        help: 'Historical time window that defines "normal". Must be longer than the observation window.',
      },
      {
        key: 'changePercent',
        label: 'Change % to alert',
        type: 'number',
        required: true,
        default: 50,
        min: 1,
        help: 'Fire an alert when the observation average deviates from the baseline average by at least this percentage.',
      },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        required: false,
        options: [
          { value: 'either', label: 'Either direction' },
          { value: 'increase', label: 'Increase only' },
          { value: 'decrease', label: 'Decrease only' },
        ],
        help: 'Whether to alert on increases, decreases, or any significant change.',
      },
      {
        key: 'minBaselineSamples',
        label: 'Min baseline samples',
        type: 'number',
        required: false,
        default: 3,
        min: 1,
        help: 'Suppress alerts until the baseline window contains at least this many readings. Prevents false positives at startup.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.view_call_change',
        config: {
          functionSignature: '{{functionSignature}}',
          resultField: '{{resultField}}',
          windowMode: 'time',
          observationMinutes: '{{observationMinutes}}',
          baselineMinutes: '{{baselineMinutes}}',
          changePercent: '{{changePercent}}',
          direction: '{{direction}}',
          minBaselineSamples: '{{minBaselineSamples}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── View Call Change — snapshot-based ───────────────────────────────
  {
    slug: 'chain-view-call-snapshot-change',
    name: 'View Call Snapshot Change Monitor',
    description:
      'Call a read-only contract function on a schedule and alert when its return value shifts by a configurable percentage relative to a baseline of N prior readings. ' +
      'Use this when you reason in poll counts: "did this value change by more than X% compared to the previous 12 readings?" ' +
      'Unlike time-based detection, the window size is defined by reading count — making it predictable regardless of polling interval and resilient during startup when few readings exist.',
    category: 'custom',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      CONTRACT_REQUIRED_INPUT,
      {
        key: 'functionSignature',
        label: 'View function signature',
        type: 'text',
        required: true,
        placeholder: 'totalSupply()',
        help: 'Read-only (view/pure) function to call periodically. Use the full Solidity signature, e.g. balanceOf(address).',
      },
      {
        key: 'resultField',
        label: 'Result field',
        type: 'text',
        required: false,
        default: 'result',
        placeholder: 'result',
        help: 'Return value key to track. Leave as "result" for single-return functions, or use the named output parameter for multi-return functions.',
      },
      {
        key: 'observationSamples',
        label: 'Observation readings',
        type: 'number',
        required: true,
        default: 3,
        min: 1,
        help: 'Number of most-recent poll readings to treat as the observation window. E.g. 3 readings at a 2-min poll interval = ~6 minutes of data.',
      },
      {
        key: 'baselineSamples',
        label: 'Baseline readings',
        type: 'number',
        required: true,
        default: 12,
        min: 1,
        help: 'Number of prior poll readings (immediately before the observation window) that define the normal baseline.',
      },
      {
        key: 'changePercent',
        label: 'Change % to alert',
        type: 'number',
        required: true,
        default: 50,
        min: 1,
        help: 'Fire an alert when the observation average deviates from the baseline average by at least this percentage.',
      },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        required: false,
        options: [
          { value: 'either', label: 'Either direction' },
          { value: 'increase', label: 'Increase only' },
          { value: 'decrease', label: 'Decrease only' },
        ],
        help: 'Whether to alert on increases, decreases, or any significant change.',
      },
      {
        key: 'minBaselineSamples',
        label: 'Min baseline samples',
        type: 'number',
        required: false,
        default: 3,
        min: 1,
        help: 'Suppress alerts until the baseline window has at least this many valid readings. Prevents false positives before enough data has been collected.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.view_call_change',
        config: {
          functionSignature: '{{functionSignature}}',
          resultField: '{{resultField}}',
          windowMode: 'snapshots',
          observationSamples: '{{observationSamples}}',
          baselineSamples: '{{baselineSamples}}',
          changePercent: '{{changePercent}}',
          direction: '{{direction}}',
          minBaselineSamples: '{{minBaselineSamples}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Windowed Sum ────────────────────────────────────────────────────
  {
    slug: 'chain-transfer-volume',
    name: 'Transfer Volume Monitor',
    description:
      'Alert when the total value transferred via a token exceeds a threshold within a rolling time window. Detects large cumulative outflows that individual transfer monitors might miss.',
    category: 'token-activity',
    severity: 'high',
    inputs: [
      NETWORK_INPUT,
      { ...CONTRACT_REQUIRED_INPUT, label: 'Token contract' },
      {
        key: 'windowMinutes',
        label: 'Time window (minutes)',
        type: 'number',
        required: true,
        default: 60,
        min: 1,
      },
      {
        key: 'threshold',
        label: 'Volume threshold',
        type: 'number',
        required: true,
        default: 1000000,
        min: 1,
        help: 'Alert when total transferred volume exceeds this amount within the window.',
      },
      {
        key: 'groupByField',
        label: 'Group by field (optional)',
        type: 'text',
        required: false,
        placeholder: 'to',
        help: 'Alert per-entity when their cumulative volume exceeds the threshold.',
      },
    ],
    rules: [
      {
        ruleType: 'chain.windowed_sum',
        config: {
          eventSignature: 'Transfer(address,address,uint256)',
          eventName: 'Transfer',
          sumField: 'value',
          windowMinutes: '{{windowMinutes}}',
          threshold: '{{threshold}}',
          operator: 'gt',
          groupByField: '{{groupByField}}',
        },
        action: 'alert',
      },
    ],
  },
];
