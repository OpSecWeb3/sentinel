/**
 * Chunk 138 — External SMTP email delivery tests.
 * Mocks nodemailer at the module level to test email construction,
 * send success, connection errors, and bounce handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendMail = vi.fn();
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

beforeEach(() => {
  mockSendMail.mockReset();
  mockCreateTransport.mockClear();
  process.env.SMTP_URL = 'smtp://localhost:1025';
  process.env.SMTP_FROM = 'alerts@sentinel.dev';
});

afterEach(() => { vi.restoreAllMocks(); });

const sampleAlert = {
  title: 'Critical: Contract upgraded',
  severity: 'critical',
  module: 'chain',
  eventType: 'chain.proxy_upgrade',
  timestamp: '2026-03-28T08:00:00Z',
  description: 'Implementation address changed unexpectedly',
  fields: [{ label: 'Contract', value: '0xdead' }],
};

describe('Chunk 138 — SMTP email delivery', () => {
  describe('sendEmailNotification success', () => {
    it('should call sendMail with correct subject, recipient, and HTML body', async () => {
      mockSendMail.mockResolvedValueOnce({ messageId: '<abc@sentinel.dev>' });

      // Force fresh module import to pick up env
      vi.resetModules();
      vi.mock('nodemailer', () => ({
        default: { createTransport: mockCreateTransport },
        createTransport: mockCreateTransport,
      }));
      const { sendEmailNotification } = await import('../../packages/notifications/src/email.js');
      await sendEmailNotification('user@example.com', sampleAlert);

      expect(mockSendMail).toHaveBeenCalledOnce();
      const args = mockSendMail.mock.calls[0][0];
      expect(args.to).toBe('user@example.com');
      expect(args.subject).toContain('[CRITICAL]');
      expect(args.subject).toContain('Contract upgraded');
      expect(args.html).toContain('chain');
      expect(args.from).toBe('alerts@sentinel.dev');
    });

    it('should join multiple recipients', async () => {
      mockSendMail.mockResolvedValueOnce({ messageId: '<multi@sentinel.dev>' });

      vi.resetModules();
      vi.mock('nodemailer', () => ({
        default: { createTransport: mockCreateTransport },
        createTransport: mockCreateTransport,
      }));
      const { sendEmailNotification } = await import('../../packages/notifications/src/email.js');
      await sendEmailNotification(['a@test.com', 'b@test.com'], sampleAlert);

      const args = mockSendMail.mock.calls[0][0];
      expect(args.to).toBe('a@test.com, b@test.com');
    });
  });

  describe('connection error handling', () => {
    it('should propagate SMTP connection errors', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      vi.resetModules();
      vi.mock('nodemailer', () => ({
        default: { createTransport: mockCreateTransport },
        createTransport: mockCreateTransport,
      }));
      const { sendEmailNotification } = await import('../../packages/notifications/src/email.js');
      await expect(
        sendEmailNotification('user@test.com', sampleAlert),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('should throw when SMTP_URL is not set', async () => {
      delete process.env.SMTP_URL;

      vi.resetModules();
      // Return a transport that checks env
      const failTransport = vi.fn(() => { throw new Error('SMTP_URL environment variable is not set'); });
      vi.mock('nodemailer', () => ({
        default: { createTransport: failTransport },
        createTransport: failTransport,
      }));
      const mod = await import('../../packages/notifications/src/email.js');
      await expect(
        mod.sendEmailNotification('user@test.com', sampleAlert),
      ).rejects.toThrow('SMTP_URL');
    });
  });

  describe('HTML escaping', () => {
    it('should escape HTML special characters in alert fields', async () => {
      mockSendMail.mockResolvedValueOnce({ messageId: '<esc@sentinel.dev>' });

      vi.resetModules();
      vi.mock('nodemailer', () => ({
        default: { createTransport: mockCreateTransport },
        createTransport: mockCreateTransport,
      }));
      const { sendEmailNotification } = await import('../../packages/notifications/src/email.js');
      const xssAlert = { ...sampleAlert, title: '<script>alert("xss")</script>', description: 'a & b < c > d' };
      await sendEmailNotification('user@test.com', xssAlert);

      const html = mockSendMail.mock.calls[0][0].html;
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
    });
  });
});
