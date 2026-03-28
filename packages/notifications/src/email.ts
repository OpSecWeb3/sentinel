/**
 * Email notification delivery via Nodemailer.
 * Ported from ChainAlert with HTML-escaped templates.
 */
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SlackAlertPayload } from './slack.js';

let _transporter: nodemailer.Transporter | undefined;

function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    const smtpUrl = process.env.SMTP_URL;
    if (!smtpUrl) throw new Error('SMTP_URL environment variable is not set');

    // Parse the URL manually so timeout options are not discarded.
    // nodemailer's `parseConnectionUrl` silently drops all other properties
    // when `url` is passed inside the options object.
    const parsed = new URL(smtpUrl);
    const opts: SMTPTransport.Options = {
      host: parsed.hostname,
      port: Number(parsed.port) || 587,
      secure: parsed.protocol === 'smtps:' || Number(parsed.port) === 465,
      ...(parsed.username
        ? { auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    };
    _transporter = nodemailer.createTransport(opts);
  }
  return _transporter;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(alert: SlackAlertPayload): string {
  const fields = (alert.fields ?? [])
    .map((f) => `<tr><td style="padding:4px 8px;font-weight:bold">${escapeHtml(f.label)}</td><td style="padding:4px 8px">${escapeHtml(f.value)}</td></tr>`)
    .join('');

  return `
    <div style="max-width:600px;margin:0 auto;font-family:system-ui,sans-serif">
      <h2 style="margin-bottom:4px">${escapeHtml(alert.title)}</h2>
      <p style="color:#666;margin-top:0">${escapeHtml(alert.severity.toUpperCase())} &middot; ${escapeHtml(alert.module)} &middot; ${escapeHtml(alert.timestamp)}</p>
      ${alert.description ? `<p>${escapeHtml(alert.description)}</p>` : ''}
      ${fields ? `<table style="border-collapse:collapse;width:100%">${fields}</table>` : ''}
      <hr style="margin-top:24px;border:none;border-top:1px solid #eee">
      <p style="color:#999;font-size:12px">Sentinel Security Platform</p>
    </div>
  `;
}

export async function sendEmailNotification(
  to: string | string[],
  alert: SlackAlertPayload,
  from?: string,
): Promise<void> {
  const subject = `[${alert.severity.toUpperCase()}] ${alert.title}`;
  const recipients = Array.isArray(to) ? to.join(', ') : to;

  await getTransporter().sendMail({
    from: from ?? process.env.SMTP_FROM ?? 'alerts@sentinel.dev',
    to: recipients,
    subject,
    html: buildHtml(alert),
  });
}
