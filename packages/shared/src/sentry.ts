/**
 * Sentry integration — opt-in via SENTRY_DSN env var.
 *
 * When SENTRY_DSN is not set, all exports are no-ops with zero overhead.
 * Sentry is loaded via dynamic import() to avoid bundling when disabled.
 */
import type { Logger } from './logger.js';

let _initialized = false;
let _sentry: typeof import('@sentry/node') | null = null;

export interface SentryInitOptions {
  dsn?: string;
  service: string;
  environment?: string;
  release?: string;
}

/**
 * Initialize Sentry. No-op if dsn is falsy.
 */
export async function initSentry(opts: SentryInitOptions): Promise<void> {
  if (!opts.dsn) return;

  try {
    _sentry = await import('@sentry/node');
    _sentry.init({
      dsn: opts.dsn,
      environment: opts.environment ?? process.env.NODE_ENV ?? 'development',
      serverName: opts.service,
      release: opts.release,
      // Capture 100% of errors, sample 10% of transactions
      tracesSampleRate: 0.1,
    });
    _initialized = true;
  } catch {
    // Sentry SDK not installed or failed to init — continue without it
  }
}

/**
 * Capture an exception in Sentry. No-op if Sentry is not initialized.
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!_initialized || !_sentry) return;
  _sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Set up global process handlers for unhandled rejections and uncaught exceptions.
 * Logs to the provided logger and reports to Sentry.
 */
export function setupGlobalHandlers(log: Logger): void {
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'Unhandled promise rejection');
    captureException(reason);
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    captureException(err);
    // In test mode, let the test runner handle uncaught exceptions instead of
    // calling process.exit which vitest intercepts and turns into a test failure.
    if (process.env.NODE_ENV === 'test') return;
    // Give Sentry time to flush, then exit
    if (_sentry && _initialized) {
      _sentry.close(2000).finally(() => process.exit(1));
    } else {
      setTimeout(() => process.exit(1), 100);
    }
  });
}
