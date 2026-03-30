import type { QueryState } from './types';
import { genId, defaultQueryState } from './utils';

export interface QueryTemplate {
  name: string;
  description: string;
  icon: string;
  state: QueryState;
}

function template(
  name: string,
  description: string,
  icon: string,
  overrides: Partial<QueryState> & Pick<QueryState, 'collection' | 'groups'>,
): QueryTemplate {
  return {
    name,
    description,
    icon,
    state: { ...defaultQueryState(), ...overrides },
  };
}

function hours(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

export const QUERY_TEMPLATES: QueryTemplate[] = [
  template('Failed AWS actions (24h)', 'AWS CloudTrail errors in the last 24 hours', '$', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'moduleId', operator: 'eq', value: 'aws' },
      { id: genId(), field: 'payload.errorCode', operator: 'exists', value: '' },
    ]}],
    timeRange: { from: hours(24), to: null },
  }),
  template('Critical alerts this week', 'All critical severity alerts from the past 7 days', '*', {
    collection: 'alerts',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'severity', operator: 'eq', value: 'critical' },
    ]}],
    timeRange: { from: hours(168), to: null },
  }),
  template('GitHub permission changes', 'Member added, removed, or edited events', '@', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'eventType', operator: 'in', value: ['github.member.added', 'github.member.removed', 'github.member.edited'] },
    ]}],
  }),
  template('Large on-chain transfers', 'Significant value transfers detected on-chain', '&', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'eventType', operator: 'eq', value: 'chain.event.large_transfer' },
    ]}],
  }),
  template('Registry supply chain (7d)', 'All registry module events from the past week', '%', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'moduleId', operator: 'eq', value: 'registry' },
    ]}],
    timeRange: { from: hours(168), to: null },
  }),
  template('Unnotified alerts', 'Alerts with pending or failed notification status', '!', {
    collection: 'alerts',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'notificationStatus', operator: 'in', value: ['pending', 'failed'] },
    ]}],
  }),
  template('Events from IP', 'AWS events from a specific source IP address', '$', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'moduleId', operator: 'eq', value: 'aws' },
      { id: genId(), field: 'payload.sourceIPAddress', operator: 'eq', value: '' },
    ]}],
  }),
  template('Certificate issues', 'Infrastructure certificate expiry and TLS problems', '^', {
    collection: 'events',
    groups: [{ id: genId(), logic: 'AND', clauses: [
      { id: genId(), field: 'eventType', operator: 'in', value: ['infra.cert.expiring', 'infra.cert.expired', 'infra.cert.issue'] },
    ]}],
  }),
];
