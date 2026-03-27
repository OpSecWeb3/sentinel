/**
 * Structured logging via Pino.
 *
 * - JSON output in production (for log aggregators)
 * - Pretty-printed output in development (via pino-pretty)
 * - LOG_LEVEL env var controls verbosity (default: 'info')
 */
import pino from 'pino';

export type Logger = pino.Logger;

const DEFAULT_LEVEL = 'info';

export interface CreateLoggerOptions {
  service?: string;
  level?: string;
}

/**
 * Create a Pino logger instance.
 * In development, uses pino-pretty for human-readable output.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? DEFAULT_LEVEL;
  const service = opts.service ?? 'sentinel';
  const isDev = process.env.NODE_ENV !== 'production';

  const transport: pino.TransportSingleOptions | undefined = isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
    : undefined;

  return pino({
    level,
    base: { service, env: process.env.NODE_ENV ?? 'development' },
    ...(transport ? { transport } : {}),
  });
}

/** Root logger singleton — use for imports that don't need a child. */
export const logger = createLogger();
