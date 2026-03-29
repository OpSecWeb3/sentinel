import { describe, it, expect } from 'vitest';
import { normalizeCloudTrailEvent, extractResourceSummary, extractPrincipal } from '../normalizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-1';

function baseCloudTrailRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventName: 'CreateUser',
    eventSource: 'iam.amazonaws.com',
    eventID: 'abc-123',
    eventTime: '2026-03-26T12:00:00Z',
    awsRegion: 'us-east-1',
    sourceIPAddress: '1.2.3.4',
    userIdentity: {
      type: 'IAMUser',
      arn: 'arn:aws:iam::123456:user/alice',
      principalId: 'AIDA123',
      accountId: '123456',
    },
    ...overrides,
  };
}

function baseEventBridgeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'detail-type': 'EC2 Spot Instance Interruption Warning',
    source: 'aws.ec2',
    id: 'eb-evt-1',
    time: '2026-03-26T14:00:00Z',
    region: 'us-west-2',
    account: '123456',
    detail: {
      'instance-id': 'i-0abc123def456',
      'instance-action': 'terminate',
    },
    ...overrides,
  };
}

// ===========================================================================
// Standard CloudTrail API event normalization
// ===========================================================================

describe('normalizeCloudTrailEvent — standard CloudTrail', () => {
  it('normalizes a standard API event with all required fields', () => {
    const record = baseCloudTrailRecord();
    const result = normalizeCloudTrailEvent(record, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe('aws');
    expect(result!.eventType).toBe('aws.iam.CreateUser');
    expect(result!.orgId).toBe(ORG_ID);
    expect(result!.externalId).toBe('abc-123');
    expect(result!.payload).toBe(record);
    expect(result!.occurredAt).toEqual(new Date('2026-03-26T12:00:00Z'));
  });

  it('returns null when eventName is missing', () => {
    const record = baseCloudTrailRecord({ eventName: undefined });
    delete record.eventName;
    const result = normalizeCloudTrailEvent(record, ORG_ID);
    expect(result).toBeNull();
  });

  it('returns null when eventSource is missing', () => {
    const record = baseCloudTrailRecord({ eventSource: undefined });
    delete record.eventSource;
    const result = normalizeCloudTrailEvent(record, ORG_ID);
    expect(result).toBeNull();
  });

  it('returns null when eventID is missing', () => {
    const record = baseCloudTrailRecord({ eventID: undefined });
    delete record.eventID;
    const result = normalizeCloudTrailEvent(record, ORG_ID);
    expect(result).toBeNull();
  });

  it('returns null when eventTime is missing', () => {
    const record = baseCloudTrailRecord({ eventTime: undefined });
    delete record.eventTime;
    const result = normalizeCloudTrailEvent(record, ORG_ID);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Service resolution
// ===========================================================================

describe('normalizeCloudTrailEvent — service resolution', () => {
  it('resolves iam.amazonaws.com to aws.iam', () => {
    const result = normalizeCloudTrailEvent(
      baseCloudTrailRecord({ eventSource: 'iam.amazonaws.com', eventName: 'CreateRole' }),
      ORG_ID,
    );
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('aws.iam.CreateRole');
  });

  it('resolves signin.amazonaws.com to aws.signin', () => {
    const result = normalizeCloudTrailEvent(
      baseCloudTrailRecord({ eventSource: 'signin.amazonaws.com', eventName: 'ConsoleLogin' }),
      ORG_ID,
    );
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('aws.signin.ConsoleLogin');
  });

  it('resolves s3.amazonaws.com to aws.s3', () => {
    const result = normalizeCloudTrailEvent(
      baseCloudTrailRecord({ eventSource: 's3.amazonaws.com', eventName: 'PutBucketAcl' }),
      ORG_ID,
    );
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('aws.s3.PutBucketAcl');
  });

  it('falls back to stripping .amazonaws.com for unknown services', () => {
    const result = normalizeCloudTrailEvent(
      baseCloudTrailRecord({ eventSource: 'dynamodb.amazonaws.com', eventName: 'DeleteTable' }),
      ORG_ID,
    );
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('aws.dynamodb.DeleteTable');
  });

  it('handles multi-segment unknown service names (replaces dots with hyphens)', () => {
    const result = normalizeCloudTrailEvent(
      baseCloudTrailRecord({ eventSource: 'monitoring.us-east-1.amazonaws.com', eventName: 'GetDashboard' }),
      ORG_ID,
    );
    expect(result).not.toBeNull();
    // After removing .amazonaws.com: "monitoring.us-east-1" → dots → hyphens
    expect(result!.eventType).toBe('aws.monitoring-us-east-1.GetDashboard');
  });
});

// ===========================================================================
// EventBridge native event normalization
// ===========================================================================

describe('normalizeCloudTrailEvent — EventBridge events', () => {
  it('normalizes a known EventBridge event (Spot interruption)', () => {
    const record = baseEventBridgeRecord();
    const result = normalizeCloudTrailEvent(record, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe('aws');
    expect(result!.eventType).toBe('aws.ec2.SpotInstanceInterruption');
    expect(result!.orgId).toBe(ORG_ID);
    expect(result!.externalId).toBe('eb-evt-1');
    expect(result!.occurredAt).toEqual(new Date('2026-03-26T14:00:00Z'));
    expect(result!.payload.eventName).toBe('EC2 Spot Instance Interruption Warning');
    expect(result!.payload.detail).toEqual({
      'instance-id': 'i-0abc123def456',
      'instance-action': 'terminate',
    });
  });

  it('normalizes EC2 Instance State-change Notification', () => {
    const record = baseEventBridgeRecord({
      'detail-type': 'EC2 Instance State-change Notification',
      detail: { 'instance-id': 'i-0abc', state: 'terminated' },
    });
    const result = normalizeCloudTrailEvent(record, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('aws.ec2.InstanceStateChange');
  });

  it('derives event type for unknown EventBridge detail-type', () => {
    const record = baseEventBridgeRecord({
      'detail-type': 'Custom App Event',
      source: 'aws.myapp',
    });
    const result = normalizeCloudTrailEvent(record, ORG_ID);

    expect(result).not.toBeNull();
    // Unknown detail-type: aws.{source minus aws.}.{detailType no spaces}
    expect(result!.eventType).toBe('aws.myapp.CustomAppEvent');
  });

  it('generates deterministic external ID when id field is missing', () => {
    const record = baseEventBridgeRecord({ id: undefined });
    delete record.id;

    const result1 = normalizeCloudTrailEvent(record, ORG_ID);
    const result2 = normalizeCloudTrailEvent(record, ORG_ID);

    expect(result1).not.toBeNull();
    expect(result1!.externalId).toMatch(/^eb-/);
    // Deterministic: same input produces the same ID
    expect(result1!.externalId).toBe(result2!.externalId);
  });

  it('generates different external IDs for different inputs', () => {
    const record1 = baseEventBridgeRecord({ id: undefined, account: '111111' });
    delete record1.id;
    const record2 = baseEventBridgeRecord({ id: undefined, account: '222222' });
    delete record2.id;

    const result1 = normalizeCloudTrailEvent(record1, ORG_ID);
    const result2 = normalizeCloudTrailEvent(record2, ORG_ID);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.externalId).not.toBe(result2!.externalId);
  });
});

// ===========================================================================
// extractResourceSummary
// ===========================================================================

describe('extractResourceSummary', () => {
  it('returns ARN from resources array', () => {
    const record = {
      resources: [{ ARN: 'arn:aws:iam::123456:user/alice', resourceName: 'alice' }],
    };
    expect(extractResourceSummary(record)).toBe('arn:aws:iam::123456:user/alice');
  });

  it('falls back to resourceName when ARN is missing', () => {
    const record = {
      resources: [{ resourceName: 'my-key' }],
    };
    expect(extractResourceSummary(record)).toBe('my-key');
  });

  it('falls back to requestParameters when resources is empty', () => {
    const record = {
      resources: [],
      requestParameters: { userName: 'bob' },
    };
    expect(extractResourceSummary(record)).toBe('bob');
  });

  it('falls back to requestParameters when resources is absent', () => {
    const record = {
      requestParameters: { roleName: 'admin-role' },
    };
    expect(extractResourceSummary(record)).toBe('admin-role');
  });

  it('tries multiple requestParameter candidates', () => {
    const record = {
      requestParameters: { bucketName: 'my-bucket' },
    };
    expect(extractResourceSummary(record)).toBe('my-bucket');
  });

  it('returns null when requestParameters has no known candidate keys', () => {
    const record = {
      requestParameters: { someUnknownParam: 'value' },
    };
    expect(extractResourceSummary(record)).toBeNull();
  });

  it('returns null when both resources and requestParameters are absent', () => {
    expect(extractResourceSummary({})).toBeNull();
  });

  it('returns null when resources is absent and requestParameters is absent', () => {
    const record = { eventName: 'DescribeInstances' };
    expect(extractResourceSummary(record)).toBeNull();
  });
});

// ===========================================================================
// extractPrincipal
// ===========================================================================

describe('extractPrincipal', () => {
  it('extracts all fields from userIdentity', () => {
    const record = {
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456:user/alice',
        principalId: 'AIDA123',
        accountId: '123456',
      },
    };
    const result = extractPrincipal(record);

    expect(result.principalId).toBe('AIDA123');
    expect(result.userArn).toBe('arn:aws:iam::123456:user/alice');
    expect(result.userType).toBe('IAMUser');
    expect(result.accountId).toBe('123456');
  });

  it('returns nulls when userIdentity is missing', () => {
    const result = extractPrincipal({});

    expect(result.principalId).toBeNull();
    expect(result.userArn).toBeNull();
    expect(result.userType).toBeNull();
    expect(result.accountId).toBeNull();
  });

  it('returns null for missing subfields', () => {
    const record = {
      userIdentity: { type: 'Root' },
    };
    const result = extractPrincipal(record);

    expect(result.userType).toBe('Root');
    expect(result.principalId).toBeNull();
    expect(result.userArn).toBeNull();
    expect(result.accountId).toBeNull();
  });
});
