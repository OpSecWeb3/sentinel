/**
 * Chain module — Slack Block Kit formatter.
 *
 * Field labels come from triggerData set by chain evaluators.
 * Properties: contractAddress, transactionHash, eventName, blockNumber,
 * address, currentValue, previousValue, percentChange, direction, etc.
 */
import type { SlackAlertFields as SlackAlertPayload } from '@sentinel/shared/module';

const EXPLORER_BASE: Record<string, string> = {
  'ethereum': 'https://etherscan.io',
  'ethereum mainnet': 'https://etherscan.io',
  'mainnet': 'https://etherscan.io',
  'goerli': 'https://goerli.etherscan.io',
  'sepolia': 'https://sepolia.etherscan.io',
  'polygon': 'https://polygonscan.com',
  'polygon mainnet': 'https://polygonscan.com',
  'arbitrum': 'https://arbiscan.io',
  'arbitrum one': 'https://arbiscan.io',
  'optimism': 'https://optimistic.etherscan.io',
  'base': 'https://basescan.org',
  'bsc': 'https://bscscan.com',
  'binance smart chain': 'https://bscscan.com',
  'avalanche': 'https://snowtrace.io',
  'fantom': 'https://ftmscan.com',
  'gnosis': 'https://gnosisscan.io',
  'linea': 'https://lineascan.build',
  'scroll': 'https://scrollscan.com',
  'zksync': 'https://explorer.zksync.io',
  'celo': 'https://celoscan.io',
  'blast': 'https://blastscan.io',
};

function getField(fields: Array<{ label: string; value: string }> | undefined, label: string): string | undefined {
  return fields?.find((f) => f.label === label)?.value;
}

function truncate(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function explorerBase(network: string | undefined): string | undefined {
  if (!network) return undefined;
  return EXPLORER_BASE[network.toLowerCase()];
}

function addrLink(network: string | undefined, addr: string): string {
  const base = explorerBase(network);
  return base ? `<${base}/address/${addr}|${truncate(addr)}>` : truncate(addr);
}

function txLink(network: string | undefined, hash: string): string {
  const base = explorerBase(network);
  return base ? `<${base}/tx/${hash}|${truncate(hash)}>` : truncate(hash);
}

export function formatSlackBlocks(alert: SlackAlertPayload): object[] {
  const blocks: object[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: alert.title, emoji: false },
  });

  // Chain evaluators use "network" from the event context (set by block-process handler)
  const network = getField(alert.fields, 'network');
  const contractAddress = getField(alert.fields, 'contractAddress') ?? getField(alert.fields, 'address');
  const transactionHash = getField(alert.fields, 'transactionHash');
  const blockNumber = getField(alert.fields, 'blockNumber');

  const meta: string[] = [`*Severity:* ${alert.severity.toUpperCase()}`];
  if (network) meta.push(`*Network:* ${network}`);
  if (contractAddress) meta.push(`*Contract:* ${addrLink(network, contractAddress)}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } });

  const et = alert.eventType;
  const lines: string[] = [];

  // event-match evaluator
  const eventName = getField(alert.fields, 'eventName');
  if (eventName) lines.push(`*Event:* ${eventName}`);

  // function-call-match evaluator
  const functionName = getField(alert.fields, 'functionName');
  const from = getField(alert.fields, 'from');
  if (functionName) lines.push(`*Function:* ${functionName}`);
  if (from) lines.push(`*From:* ${addrLink(network, from)}`);

  // balance-track / state-poll evaluators
  const currentValue = getField(alert.fields, 'currentValue');
  const previousValue = getField(alert.fields, 'previousValue');
  const percentChange = getField(alert.fields, 'percentChange');
  const direction = getField(alert.fields, 'direction');
  const threshold = getField(alert.fields, 'threshold');
  const conditionType = getField(alert.fields, 'conditionType');

  if (conditionType) lines.push(`*Condition:* ${conditionType}`);
  if (previousValue && currentValue) lines.push(`*Value:* ${previousValue} → ${currentValue}`);
  else if (currentValue) lines.push(`*Value:* ${currentValue}`);
  if (percentChange) lines.push(`*Change:* ${percentChange}%`);
  if (direction) lines.push(`*Direction:* ${direction}`);
  if (threshold) lines.push(`*Threshold:* ${threshold}`);

  // windowed-count / windowed-sum / windowed-spike evaluators
  const count = getField(alert.fields, 'count');
  const sum = getField(alert.fields, 'sum');
  const windowMinutes = getField(alert.fields, 'windowMinutes');
  const spikePercent = getField(alert.fields, 'spikePercent');
  const baselineAvg = getField(alert.fields, 'baselineAvg');

  if (count) lines.push(`*Count:* ${count}`);
  if (sum) lines.push(`*Sum:* ${sum}`);
  if (windowMinutes) lines.push(`*Window:* ${windowMinutes}m`);
  if (spikePercent) lines.push(`*Spike:* ${spikePercent}%`);
  if (baselineAvg) lines.push(`*Baseline avg:* ${baselineAvg}`);

  // view-call / view-call-change evaluators
  const currentAvg = getField(alert.fields, 'currentAvg');
  const baselineAvgVc = getField(alert.fields, 'baselineAvg');
  if (currentAvg && !baselineAvg) lines.push(`*Current avg:* ${currentAvg}`);
  if (baselineAvgVc && !baselineAvg) lines.push(`*Baseline avg:* ${baselineAvgVc}`);

  // Token address for balance-track
  const tokenAddress = getField(alert.fields, 'tokenAddress');
  if (tokenAddress) lines.push(`*Token:* ${addrLink(network, tokenAddress)}`);

  if (transactionHash) lines.push(`*Tx:* ${txLink(network, transactionHash)}`);
  if (blockNumber) lines.push(`*Block:* ${blockNumber}`);

  if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });

  if (alert.description) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alert.description } });
  }

  const footerParts: string[] = [];
  if (alert.alertUrl) footerParts.push(`<${alert.alertUrl}|View Alert>`);
  footerParts.push(alert.timestamp);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footerParts.join('  |  ') }] });
  blocks.push({ type: 'divider' });
  return blocks;
}
