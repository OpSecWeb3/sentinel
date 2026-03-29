/**
 * Alert dispatch — routes an alert to its configured notification channels.
 * Tracks per-channel success/failure. Ported from ChainAlert.
 */
import { decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import { sendSlackMessage, type SlackAlertPayload } from './slack.js';
import { sendEmailNotification } from './email.js';
import { sendWebhookNotification } from './webhook.js';

export interface NotificationResult {
  channelId: string;
  type: string;
  status: 'sent' | 'failed' | 'circuit_open';
  error?: string;
  statusCode?: number;
  responseTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Per-channel circuit breaker — prevents hammering a flaky channel on every
// retry while it's down.  Opens after THRESHOLD consecutive failures and
// resets after RESET_MS.  Kept in-process memory (stateless across restarts).
// ---------------------------------------------------------------------------

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60_000; // 1 minute
/** Cap in-process circuit entries so deleted channel IDs cannot grow memory without bound. */
const CIRCUITS_MAX = 10_000;

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

const circuits = new Map<string, CircuitState>();

function getCircuit(channelId: string): CircuitState {
  let state = circuits.get(channelId);
  if (!state) {
    if (circuits.size >= CIRCUITS_MAX) {
      const oldest = circuits.keys().next().value;
      if (oldest !== undefined) circuits.delete(oldest);
    }
    state = { failures: 0, openedAt: null };
    circuits.set(channelId, state);
  }
  return state;
}

function isCircuitOpen(channelId: string): boolean {
  const state = getCircuit(channelId);
  if (state.openedAt === null) return false;
  // Allow a probe after the reset window
  if (Date.now() - state.openedAt >= CIRCUIT_RESET_MS) {
    state.failures = 0;
    state.openedAt = null;
    return false;
  }
  return true;
}

function recordSuccess(channelId: string): void {
  const state = getCircuit(channelId);
  state.failures = 0;
  state.openedAt = null;
}

function recordFailure(channelId: string): void {
  const state = getCircuit(channelId);
  state.failures++;
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.openedAt = Date.now();
  }
}

export interface ChannelRow {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * Dispatch an alert payload to a list of notification channels.
 * Returns per-channel results. Throws only if ALL channels fail.
 */
export async function dispatchAlert(
  channels: ChannelRow[],
  alert: SlackAlertPayload,
  slackBotToken?: string | null,
  slackChannelId?: string | null,
  formatBlocks?: (alert: SlackAlertPayload) => object[],
  log?: Logger,
): Promise<NotificationResult[]> {
  const _log = log ?? rootLogger.child({ component: 'dispatcher' });
  const results: NotificationResult[] = [];

  // Direct Slack (bot token + channel ID from detection config)
  if (slackBotToken && slackChannelId) {
    if (isCircuitOpen(slackChannelId)) {
      _log.warn({ channelId: slackChannelId, type: 'slack' }, 'Circuit breaker open — skipping channel');
      results.push({ channelId: slackChannelId, type: 'slack', status: 'circuit_open', error: 'Circuit breaker open' });
    } else {
      const start = performance.now();
      try {
        await sendSlackMessage(slackBotToken, slackChannelId, alert, formatBlocks);
        const elapsed = Math.round(performance.now() - start);
        recordSuccess(slackChannelId);
        results.push({ channelId: slackChannelId, type: 'slack', status: 'sent', responseTimeMs: elapsed });
      } catch (err) {
        const elapsed = Math.round(performance.now() - start);
        recordFailure(slackChannelId);
        results.push({
          channelId: slackChannelId,
          type: 'slack',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          responseTimeMs: elapsed,
        });
      }
    }
  }

  // Configured channels
  for (const channel of channels) {
    if (isCircuitOpen(channel.id)) {
      _log.warn({ channelId: channel.id, type: channel.type }, 'Circuit breaker open — skipping channel');
      results.push({ channelId: channel.id, type: channel.type, status: 'circuit_open', error: 'Circuit breaker open' });
      continue;
    }
    const start = performance.now();
    try {
      switch (channel.type) {
        case 'email': {
          const recipients = (
            channel.config.recipients ?? (channel.config.to ? [channel.config.to] : [])
          ) as string[];
          if (!recipients.length) throw new Error('Email channel missing recipients');
          await sendEmailNotification(recipients, alert);
          break;
        }
        case 'webhook': {
          const url = channel.config.url as string;
          const encryptedSecret = channel.config.secret as string;
          if (!url || !encryptedSecret) throw new Error('Webhook channel missing url or secret');
          const secret = decrypt(encryptedSecret);
          await sendWebhookNotification(
            { url, secret, headers: channel.config.headers as Record<string, string> },
            { alert },
          );
          break;
        }
        default:
          _log.warn({ channelType: channel.type, channelId: channel.id }, 'Unknown channel type');
          continue;
      }
      const elapsed = Math.round(performance.now() - start);
      recordSuccess(channel.id);
      results.push({ channelId: channel.id, type: channel.type, status: 'sent', responseTimeMs: elapsed });
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      recordFailure(channel.id);
      results.push({
        channelId: channel.id,
        type: channel.type,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        responseTimeMs: elapsed,
      });
    }
  }

  // Throw if ALL channels failed (triggers BullMQ retry).
  // Circuit-open channels are treated as failures for this check — if every
  // channel is either failed or circuit-open, nothing was delivered.
  const allFailed = results.length > 0 && results.every((r) => r.status !== 'sent');
  if (allFailed) {
    const errors = results.map((r) => `${r.type}: ${r.error}`).join('; ');
    throw new Error(`All notification channels failed: ${errors}`);
  }

  return results;
}
