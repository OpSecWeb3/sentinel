import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Server-side Sentry is handled by the API/worker processes.
    // This hook exists so Next.js loads sentry.client.config.ts on the client.
  }
}

export const onRequestError = Sentry.captureRequestError;
