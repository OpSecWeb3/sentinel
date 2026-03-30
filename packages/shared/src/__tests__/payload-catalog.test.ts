import { describe, it, expect } from 'vitest';
import { extractFieldPaths } from '../payload-catalog.js';

// ===========================================================================
// extractFieldPaths — JSON key path extraction
// ===========================================================================

describe('extractFieldPaths', () => {
  it('extracts top-level string fields', () => {
    const result = extractFieldPaths({ name: 'alice', action: 'created' });
    expect(result).toContainEqual({ path: 'name', type: 'string' });
    expect(result).toContainEqual({ path: 'action', type: 'string' });
  });

  it('extracts number fields', () => {
    const result = extractFieldPaths({ count: 42, rate: 3.14 });
    expect(result).toContainEqual({ path: 'count', type: 'number' });
    expect(result).toContainEqual({ path: 'rate', type: 'number' });
  });

  it('extracts boolean fields', () => {
    const result = extractFieldPaths({ forced: true, deleted: false });
    expect(result).toContainEqual({ path: 'forced', type: 'boolean' });
    expect(result).toContainEqual({ path: 'deleted', type: 'boolean' });
  });

  it('extracts array fields without recursing into elements', () => {
    const result = extractFieldPaths({ tags: ['a', 'b'], items: [1, 2] });
    expect(result).toContainEqual({ path: 'tags', type: 'array' });
    expect(result).toContainEqual({ path: 'items', type: 'array' });
    // Should NOT have tags.0, items.0, etc.
    expect(result.find((f) => f.path.includes('.0'))).toBeUndefined();
  });

  it('handles null values', () => {
    const result = extractFieldPaths({ errorCode: null });
    expect(result).toContainEqual({ path: 'errorCode', type: 'null' });
  });

  it('recurses into nested objects with dotted paths', () => {
    const result = extractFieldPaths({
      sender: { login: 'octocat', id: 583231 },
    });
    expect(result).toContainEqual({ path: 'sender', type: 'object' });
    expect(result).toContainEqual({ path: 'sender.login', type: 'string' });
    expect(result).toContainEqual({ path: 'sender.id', type: 'number' });
  });

  it('recurses to multiple levels', () => {
    const result = extractFieldPaths({
      a: { b: { c: 'deep' } },
    });
    expect(result).toContainEqual({ path: 'a.b.c', type: 'string' });
  });

  it('stops at MAX_DEPTH (5 levels)', () => {
    const result = extractFieldPaths({
      l1: { l2: { l3: { l4: { l5: { l6: 'too deep' } } } } },
    });
    // Should have l1 through l1.l2.l3.l4, but NOT l1.l2.l3.l4.l5.l6
    expect(result.find((f) => f.path === 'l1.l2.l3.l4.l5')).toBeDefined();
    expect(result.find((f) => f.path === 'l1.l2.l3.l4.l5.l6')).toBeUndefined();
  });

  it('skips keys starting with underscore', () => {
    const result = extractFieldPaths({ _internal: 'secret', visible: 'yes' });
    expect(result.find((f) => f.path === '_internal')).toBeUndefined();
    expect(result).toContainEqual({ path: 'visible', type: 'string' });
  });

  it('handles empty object', () => {
    const result = extractFieldPaths({});
    expect(result).toHaveLength(0);
  });

  it('handles a real GitHub push payload', () => {
    const payload = {
      resourceId: 'acme/api',
      ref: 'refs/heads/main',
      forced: true,
      repository: { full_name: 'acme/api', id: 100200 },
      pusher: { name: 'dev', email: 'dev@acme.com' },
      sender: { login: 'dev', id: 9001 },
      commits_count: 3,
      head_commit: { id: 'abc1234', message: 'fix: stuff' },
    };
    const result = extractFieldPaths(payload);

    // Top-level
    expect(result).toContainEqual({ path: 'resourceId', type: 'string' });
    expect(result).toContainEqual({ path: 'forced', type: 'boolean' });
    expect(result).toContainEqual({ path: 'commits_count', type: 'number' });

    // Nested
    expect(result).toContainEqual({ path: 'repository.full_name', type: 'string' });
    expect(result).toContainEqual({ path: 'sender.login', type: 'string' });
    expect(result).toContainEqual({ path: 'head_commit.message', type: 'string' });
  });

  it('handles a real AWS CloudTrail payload', () => {
    const payload = {
      eventName: 'CreateAccessKey',
      eventSource: 'iam.amazonaws.com',
      awsRegion: 'us-east-1',
      sourceIPAddress: '203.0.113.42',
      userIdentity: { type: 'Root', arn: 'arn:aws:iam::123:root', accountId: '123' },
      errorCode: 'AccessDenied',
    };
    const result = extractFieldPaths(payload);

    expect(result).toContainEqual({ path: 'eventName', type: 'string' });
    expect(result).toContainEqual({ path: 'errorCode', type: 'string' });
    expect(result).toContainEqual({ path: 'userIdentity.arn', type: 'string' });
    expect(result).toContainEqual({ path: 'userIdentity.type', type: 'string' });
  });

  it('handles a real chain event matched payload', () => {
    const payload = {
      resourceId: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      matchType: 'chain.event_match',
      networkSlug: 'ethereum',
      chainId: 1,
      blockNumber: '19500000',
      transactionHash: '0xabc123',
      logIndex: 42,
      contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      eventName: 'Transfer',
      eventArgs: { from: '0x1111', to: '0x2222', value: '500' },
    };
    const result = extractFieldPaths(payload);

    expect(result).toContainEqual({ path: 'chainId', type: 'number' });
    expect(result).toContainEqual({ path: 'logIndex', type: 'number' });
    expect(result).toContainEqual({ path: 'eventArgs.from', type: 'string' });
    expect(result).toContainEqual({ path: 'eventArgs.value', type: 'string' });
  });
});
