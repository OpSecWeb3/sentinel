import type { DetectionTemplate } from '@sentinel/shared/module';
import { WELL_KNOWN_SLOTS } from '../well-known-slots.js';

export const templates: DetectionTemplate[] = [
  // ── Token Activity ─────────────────────────────────────────────────────
  {
    slug: 'chain-large-transfer',
    name: 'Large Transfer Monitor',
    description:
      'Alert when an ERC-20 Transfer event moves more than a specified amount of tokens. Catches whale movements and potential exploits.',
    category: 'token-activity',
    severity: 'high',
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
    rules: [
      {
        ruleType: 'chain.state_poll',
        config: {
          slot: '{{slot}}',
          pollIntervalMs: '{{pollIntervalMs}}',
          condition: {
            type: '{{conditionType}}',
            value: '{{conditionValue}}',
            percentThreshold: '{{percentThreshold}}',
            windowSize: '{{windowSize}}',
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

  // ── Custom ─────────────────────────────────────────────────────────────
  {
    slug: 'chain-custom-event',
    name: 'Custom Event Monitor',
    description:
      'Watch for any on-chain event by providing its Solidity signature. Optionally filter on decoded parameters.',
    category: 'custom',
    severity: 'medium',
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

  // ── Windowed Sum ────────────────────────────────────────────────────
  {
    slug: 'chain-transfer-volume',
    name: 'Transfer Volume Monitor',
    description:
      'Alert when the total value transferred via a token exceeds a threshold within a rolling time window. Detects large cumulative outflows that individual transfer monitors might miss.',
    category: 'token-activity',
    severity: 'high',
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
