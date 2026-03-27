/**
 * Normalizes a raw CloudTrail event record into the platform Event format.
 */

// EventBridge detail-type → sentinel event type (for native EventBridge events,
// not CloudTrail API calls)
const EVENTBRIDGE_TYPE_MAP: Record<string, string> = {
  'EC2 Spot Instance Interruption Warning': 'aws.ec2.SpotInstanceInterruption',
  'EC2 Instance State-change Notification': 'aws.ec2.InstanceStateChange',
  'EC2 Instance Rebalance Recommendation': 'aws.ec2.SpotRebalanceRecommendation',
};

// CloudTrail event source → sentinel aws.{service} namespace
const SOURCE_MAP: Record<string, string> = {
  'iam.amazonaws.com': 'iam',
  'signin.amazonaws.com': 'signin',
  'ec2.amazonaws.com': 'ec2',
  's3.amazonaws.com': 's3',
  'cloudtrail.amazonaws.com': 'cloudtrail',
  'kms.amazonaws.com': 'kms',
  'secretsmanager.amazonaws.com': 'secretsmanager',
  'sts.amazonaws.com': 'sts',
  'lambda.amazonaws.com': 'lambda',
  'rds.amazonaws.com': 'rds',
  'eks.amazonaws.com': 'eks',
  'ecs.amazonaws.com': 'ecs',
};

function resolveService(eventSource: string): string {
  return SOURCE_MAP[eventSource] ?? eventSource.replace('.amazonaws.com', '').replace(/\./g, '-');
}

export interface NormalizedAwsEvent {
  moduleId: string;
  eventType: string;
  orgId: string;
  externalId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export function normalizeCloudTrailEvent(
  record: Record<string, unknown>,
  orgId: string,
): NormalizedAwsEvent | null {
  // Native EventBridge event (e.g. Spot interruption warning, state change)
  if (record['detail-type'] && record.source && record.detail) {
    return normalizeEventBridgeEvent(record, orgId);
  }

  // Standard CloudTrail API event
  const eventName = record.eventName as string | undefined;
  const eventSource = record.eventSource as string | undefined;
  const eventId = record.eventID as string | undefined;
  const eventTimeStr = record.eventTime as string | undefined;

  if (!eventName || !eventSource || !eventId || !eventTimeStr) return null;

  const service = resolveService(eventSource);
  const eventType = `aws.${service}.${eventName}`;

  return {
    moduleId: 'aws',
    eventType,
    orgId,
    externalId: eventId,
    payload: record,
    occurredAt: new Date(eventTimeStr),
  };
}

function normalizeEventBridgeEvent(
  record: Record<string, unknown>,
  orgId: string,
): NormalizedAwsEvent | null {
  const detailType = record['detail-type'] as string;
  const eventType = EVENTBRIDGE_TYPE_MAP[detailType];
  if (!eventType) return null;

  const id = record.id as string | undefined;
  const timeStr = record.time as string | undefined;
  const detail = record.detail as Record<string, unknown>;

  return {
    moduleId: 'aws',
    eventType,
    orgId,
    externalId: id ?? `eb-${Date.now()}`,
    payload: {
      // Normalize into a shape the evaluators can work with consistently
      eventName: detailType,
      eventSource: record.source as string ?? 'aws.ec2',
      awsRegion: record.region as string ?? '',
      accountId: record.account as string ?? '',
      userIdentity: { type: 'AWSService', principalId: record.source as string },
      detail,
      // Raw fields preserved
      ...record,
    },
    occurredAt: timeStr ? new Date(timeStr) : new Date(),
  };
}

// Extract a human-readable resource summary from a CloudTrail event
export function extractResourceSummary(record: Record<string, unknown>): string | null {
  const resources = record.resources as Array<Record<string, unknown>> | undefined;
  if (resources && resources.length > 0) {
    const first = resources[0];
    return (first?.ARN as string) ?? (first?.resourceName as string) ?? null;
  }

  // Fallback: try common request parameter patterns
  const req = record.requestParameters as Record<string, unknown> | undefined;
  if (!req) return null;

  const candidates = [
    req.userName, req.roleName, req.groupName, req.policyArn,
    req.bucketName, req.keyId, req.secretId, req.functionName,
    req.instanceId,
  ];

  for (const c of candidates) {
    if (typeof c === 'string') return c;
  }
  return null;
}

export function extractPrincipal(record: Record<string, unknown>): {
  principalId: string | null;
  userArn: string | null;
  userType: string | null;
  accountId: string | null;
} {
  const identity = record.userIdentity as Record<string, unknown> | undefined;
  if (!identity) return { principalId: null, userArn: null, userType: null, accountId: null };

  return {
    principalId: (identity.principalId as string) ?? null,
    userArn: (identity.arn as string) ?? null,
    userType: (identity.type as string) ?? null,
    accountId: (identity.accountId as string) ?? null,
  };
}
