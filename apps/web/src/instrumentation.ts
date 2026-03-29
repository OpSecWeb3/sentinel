import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Server-side Sentry is handled by the API/worker processes.
    // Client-side init lives in instrumentation-client.ts.
  }
}

export const onRequestError = Sentry.captureRequestError;
