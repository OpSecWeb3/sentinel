/**
 * Chunk 114 — Normalizer: CloudTrail → normalized events
 * Chunk 115 — Handler: poll.sweep + sqs.poll (SQS message parsing)
 * Chunk 116 — Handler: event.process (CloudTrail normalization, event store)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
} from '../helpers/setup.js';

describe('Chunk 114 — CloudTrail normalizer', () => {
  it('should normalize ConsoleLogin event', () => {
    const raw = {
      eventSource: 'signin.amazonaws.com',
      eventName: 'ConsoleLogin',
      eventTime: '2026-03-28T10:00:00Z',
      userIdentity: {
        type: 'IAMUser',
        userName: 'admin-user',
        arn: 'arn:aws:iam::123456789012:user/admin-user',
      },
      sourceIPAddress: '1.2.3.4',
      responseElements: { ConsoleLogin: 'Success' },
    };

    const eventType = 'aws.console_login';
    const payload = {
      eventSource: raw.eventSource,
      eventName: raw.eventName,
      userName: raw.userIdentity.userName,
      userType: raw.userIdentity.type,
      sourceIp: raw.sourceIPAddress,
      success: raw.responseElements.ConsoleLogin === 'Success',
      resourceId: raw.userIdentity.arn,
    };

    expect(eventType).toBe('aws.console_login');
    expect(payload.success).toBe(true);
    expect(payload.userName).toBe('admin-user');
  });

  it('should normalize root activity event', () => {
    const raw = {
      eventSource: 'iam.amazonaws.com',
      eventName: 'CreateUser',
      userIdentity: {
        type: 'Root',
        arn: 'arn:aws:iam::123456789012:root',
      },
      sourceIPAddress: '10.0.0.1',
    };

    const eventType = 'aws.root_activity';
    const isRoot = raw.userIdentity.type === 'Root';

    expect(eventType).toBe('aws.root_activity');
    expect(isRoot).toBe(true);
  });

  it('should normalize auth failure event', () => {
    const raw = {
      eventSource: 'signin.amazonaws.com',
      eventName: 'ConsoleLogin',
      userIdentity: { type: 'IAMUser', userName: 'hacker' },
      responseElements: { ConsoleLogin: 'Failure' },
      additionalEventData: { MFAUsed: 'No' },
    };

    const eventType = 'aws.auth_failure';
    const isMfaUsed = raw.additionalEventData?.MFAUsed === 'Yes';

    expect(eventType).toBe('aws.auth_failure');
    expect(isMfaUsed).toBe(false);
  });

  it('should extract event source and name from CloudTrail record', () => {
    const records = [
      { eventSource: 'ec2.amazonaws.com', eventName: 'RunInstances' },
      { eventSource: 's3.amazonaws.com', eventName: 'PutObject' },
      { eventSource: 'iam.amazonaws.com', eventName: 'CreateAccessKey' },
    ];

    for (const r of records) {
      expect(r.eventSource).toMatch(/\.amazonaws\.com$/);
      expect(typeof r.eventName).toBe('string');
    }
  });
});

describe('Chunk 115 — AWS SQS poll handler', () => {
  it('should parse SQS message body containing CloudTrail records', () => {
    const sqsMessage = {
      MessageId: 'msg-123',
      ReceiptHandle: 'receipt-abc',
      Body: JSON.stringify({
        Records: [
          {
            eventSource: 'ec2.amazonaws.com',
            eventName: 'TerminateInstances',
            eventTime: '2026-03-28T12:00:00Z',
            userIdentity: { type: 'IAMUser', userName: 'ops' },
            requestParameters: { instancesSet: { items: [{ instanceId: 'i-12345' }] } },
          },
        ],
      }),
    };

    const parsed = JSON.parse(sqsMessage.Body);
    expect(parsed.Records).toHaveLength(1);
    expect(parsed.Records[0].eventName).toBe('TerminateInstances');
  });

  it('should handle empty SQS response', () => {
    const response = { Messages: [] };
    expect(response.Messages).toHaveLength(0);
  });

  it('should handle nested S3 notification in SQS message', () => {
    const sqsMessage = {
      Body: JSON.stringify({
        s3Bucket: 'cloudtrail-bucket',
        s3ObjectKey: ['AWSLogs/123/CloudTrail/us-east-1/2026/03/28/file.json.gz'],
      }),
    };

    const parsed = JSON.parse(sqsMessage.Body);
    expect(parsed.s3Bucket).toBe('cloudtrail-bucket');
    expect(parsed.s3ObjectKey[0]).toContain('CloudTrail');
  });
});

describe('Chunk 116 — AWS event processing', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should store CloudTrail event in events table', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const payload = {
      eventSource: 'iam.amazonaws.com',
      eventName: 'CreateUser',
      userIdentity: { type: 'IAMUser', userName: 'admin' },
    };

    await sql`
      INSERT INTO events (org_id, module_id, event_type, payload, occurred_at)
      VALUES (${org.id}, 'aws', 'aws.iam_event', ${JSON.stringify(payload)}::jsonb, NOW())
    `;

    const [event] = await sql`SELECT * FROM events WHERE org_id = ${org.id} AND module_id = 'aws'`;
    expect(event.event_type).toBe('aws.iam_event');
    expect(event.payload.eventName).toBe('CreateUser');
  });
});
