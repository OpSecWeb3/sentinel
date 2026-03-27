import type { TemplateInput } from '@sentinel/shared/module';

export const NETWORK_UI_FIELD: TemplateInput = {
  key: 'networkId',
  label: 'Network',
  type: 'network',
  required: true,
};

export const CONTRACT_UI_FIELD: TemplateInput = {
  key: 'contractAddress',
  label: 'Contract',
  type: 'contract',
  required: false,
  help: 'Leave empty to monitor all contracts on this network.',
};

export const EVENT_SIG_UI_FIELD: TemplateInput = {
  key: 'eventSignature',
  label: 'Event signature',
  type: 'text',
  required: false,
  placeholder: 'Transfer(address,address,uint256)',
  help: 'ABI event signature to match. Leave empty to match all events.',
};

export const GROUP_BY_UI_FIELD: TemplateInput = {
  key: 'groupByField',
  label: 'Group by field',
  type: 'text',
  required: false,
  placeholder: 'to',
  help: 'Payload field to group events by (e.g. "from", "to").',
};
