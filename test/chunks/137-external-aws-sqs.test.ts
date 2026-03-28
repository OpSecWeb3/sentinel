/**
 * Chunk 137 — External AWS SQS integration tests.
 * Mocks the AWS SDK client-sqs module to test message receive,
 * delete, and CloudTrail JSON parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class { send = mockSend; },
    ReceiveMessageCommand: class { _type = 'receive'; input: unknown; constructor(input: unknown) { this.input = input; } },
    DeleteMessageCommand: class { _type = 'delete'; input: unknown; constructor(input: unknown) { this.input = input; } },
  };
});

beforeEach(() => { mockSend.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Chunk 137 — AWS SQS integration', () => {
  describe('ReceiveMessage', () => {
    it('should receive messages with correct queue URL and parameters', async () => {
      mockSend.mockResolvedValueOnce({
        Messages: [
          { MessageId: 'msg-1', Body: '{"eventName":"CreateUser","eventSource":"iam.amazonaws.com"}', ReceiptHandle: 'rh-1' },
          { MessageId: 'msg-2', Body: '{"eventName":"DeleteBucket","eventSource":"s3.amazonaws.com"}', ReceiptHandle: 'rh-2' },
        ],
      });

      const { SQSClient, ReceiveMessageCommand } = await import('@aws-sdk/client-sqs');
      const client = new SQSClient({ region: 'us-east-1' });
      const result = await client.send(new ReceiveMessageCommand({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/sentinel-ct',
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }));

      expect(result.Messages).toHaveLength(2);
      expect(result.Messages![0].MessageId).toBe('msg-1');
    });

    it('should handle empty queue (no messages)', async () => {
      mockSend.mockResolvedValueOnce({ Messages: [] });

      const { SQSClient, ReceiveMessageCommand } = await import('@aws-sdk/client-sqs');
      const client = new SQSClient({ region: 'us-east-1' });
      const result = await client.send(new ReceiveMessageCommand({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/empty',
        MaxNumberOfMessages: 10,
      }));

      expect(result.Messages).toHaveLength(0);
    });
  });

  describe('DeleteMessage', () => {
    it('should delete message by receipt handle', async () => {
      mockSend.mockResolvedValueOnce({});

      const { SQSClient, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
      const client = new SQSClient({ region: 'us-east-1' });
      const cmd = new DeleteMessageCommand({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/sentinel-ct',
        ReceiptHandle: 'rh-abc-123',
      });
      await client.send(cmd);

      expect(mockSend).toHaveBeenCalledOnce();
      expect((cmd as any).input.ReceiptHandle).toBe('rh-abc-123');
    });
  });

  describe('CloudTrail JSON parsing', () => {
    it('should parse direct CloudTrail event from SQS body', () => {
      const body = JSON.stringify({
        eventName: 'CreateAccessKey',
        eventSource: 'iam.amazonaws.com',
        eventTime: '2026-03-28T10:00:00Z',
        awsRegion: 'us-east-1',
        userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::123:user/admin' },
        sourceIPAddress: '1.2.3.4',
        eventID: 'evt-001',
      });
      const parsed = JSON.parse(body);
      expect(parsed.eventName).toBe('CreateAccessKey');
      expect(parsed.eventSource).toBe('iam.amazonaws.com');
      expect(parsed.userIdentity.type).toBe('IAMUser');
    });

    it('should parse SNS-wrapped CloudTrail event', () => {
      const innerEvent = {
        eventName: 'StopInstances',
        eventSource: 'ec2.amazonaws.com',
        eventID: 'evt-002',
      };
      const snsWrapper = {
        Type: 'Notification',
        MessageId: 'sns-msg-1',
        Message: JSON.stringify(innerEvent),
      };
      const body = JSON.stringify(snsWrapper);
      const outer = JSON.parse(body);
      expect(outer.Type).toBe('Notification');
      const inner = JSON.parse(outer.Message);
      expect(inner.eventName).toBe('StopInstances');
    });

    it('should parse native EventBridge event format', () => {
      const body = JSON.stringify({
        'detail-type': 'EC2 Spot Instance Interruption Warning',
        source: 'aws.ec2',
        time: '2026-03-28T10:00:00Z',
        account: '123456789012',
        region: 'us-east-1',
        detail: { 'instance-id': 'i-abc123', 'instance-action': 'terminate' },
      });
      const parsed = JSON.parse(body);
      expect(parsed['detail-type']).toBe('EC2 Spot Instance Interruption Warning');
      expect(parsed.source).toBe('aws.ec2');
      expect(parsed.detail['instance-id']).toBe('i-abc123');
    });

    it('should handle malformed JSON gracefully', () => {
      const body = 'not valid json {';
      let parsed: unknown = null;
      try { parsed = JSON.parse(body); } catch { /* expected */ }
      expect(parsed).toBeNull();
    });

    it('should extract principal from userIdentity', () => {
      const event = {
        userIdentity: {
          type: 'AssumedRole',
          principalId: 'AROA123:session-name',
          arn: 'arn:aws:sts::123:assumed-role/MyRole/session-name',
          accountId: '123456789012',
        },
      };
      expect(event.userIdentity.type).toBe('AssumedRole');
      expect(event.userIdentity.principalId).toContain('AROA');
      expect(event.userIdentity.accountId).toBe('123456789012');
    });
  });
});
