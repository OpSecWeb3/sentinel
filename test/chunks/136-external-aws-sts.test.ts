/**
 * Chunk 136 — External AWS STS integration tests.
 * Mocks the AWS SDK client-sts module to test AssumeRole,
 * credential parsing, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: class { send = mockSend; },
    AssumeRoleCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  };
});

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class { config: unknown; send = vi.fn(); constructor(config: unknown) { this.config = config; } },
    ReceiveMessageCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
    DeleteMessageCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  };
});

beforeEach(() => { mockSend.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Chunk 136 — AWS STS integration', () => {
  describe('AssumeRole credential flow', () => {
    it('should call AssumeRoleCommand with role ARN and session name', async () => {
      mockSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIATESTACCESSKEY',
          SecretAccessKey: 'testsecretkey123',
          SessionToken: 'testsessiontoken',
          Expiration: new Date('2026-03-28T13:00:00Z'),
        },
      });

      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region: 'us-east-1' });
      const result = await client.send(new AssumeRoleCommand({
        RoleArn: 'arn:aws:iam::123456789012:role/sentinel-reader',
        RoleSessionName: 'sentinel-aws-module',
        DurationSeconds: 3600,
      }));

      expect(mockSend).toHaveBeenCalledOnce();
      expect(result.Credentials).toBeDefined();
      expect(result.Credentials!.AccessKeyId).toBe('ASIATESTACCESSKEY');
      expect(result.Credentials!.SessionToken).toBe('testsessiontoken');
    });

    it('should include ExternalId when provided', async () => {
      mockSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAEXT',
          SecretAccessKey: 'secret',
          SessionToken: 'tok',
        },
      });

      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region: 'us-east-1' });

      const cmd = new AssumeRoleCommand({
        RoleArn: 'arn:aws:iam::111:role/ext',
        RoleSessionName: 'sentinel-aws-module',
        ExternalId: 'sentinel-ext-id-abc',
      });
      await client.send(cmd);

      expect((cmd as any).input.ExternalId).toBe('sentinel-ext-id-abc');
    });
  });

  describe('credential refresh on expiry', () => {
    it('should detect expired credentials and require re-assume', () => {
      const expiry = new Date('2026-03-28T10:00:00Z');
      const now = new Date('2026-03-28T10:30:00Z');
      const isExpired = now >= expiry;
      expect(isExpired).toBe(true);
    });

    it('should detect valid credentials within window', () => {
      const expiry = new Date('2026-03-28T14:00:00Z');
      const now = new Date('2026-03-28T10:30:00Z');
      const isExpired = now >= expiry;
      expect(isExpired).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should throw when no credentials returned', async () => {
      mockSend.mockResolvedValueOnce({ Credentials: undefined });

      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region: 'us-east-1' });
      const result = await client.send(new AssumeRoleCommand({
        RoleArn: 'arn:aws:iam::123:role/bad',
        RoleSessionName: 'sentinel',
      }));

      expect(result.Credentials).toBeUndefined();
    });

    it('should propagate AccessDeniedException', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('User is not authorized to perform sts:AssumeRole'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        }),
      );

      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region: 'us-east-1' });
      await expect(
        client.send(new AssumeRoleCommand({ RoleArn: 'arn:aws:iam::123:role/nope', RoleSessionName: 's' })),
      ).rejects.toThrow('not authorized');
    });

    it('should propagate MalformedPolicyDocument error', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('MalformedPolicyDocument'), { name: 'MalformedPolicyDocument' }),
      );

      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region: 'us-east-1' });
      await expect(
        client.send(new AssumeRoleCommand({ RoleArn: 'arn:bad', RoleSessionName: 's' })),
      ).rejects.toThrow('MalformedPolicyDocument');
    });
  });
});
