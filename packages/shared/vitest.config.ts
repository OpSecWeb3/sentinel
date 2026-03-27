import { defineConfig } from 'vitest/config';

/**
 * Unit tests for @sentinel/shared utilities.
 *
 * These are pure-logic tests that do NOT require a database or Redis.
 * They run fast, in parallel, and are the first line of defence.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 5_000,
    hookTimeout: 10_000,

    // Shared utilities are pure functions -- safe to run in parallel.
    pool: 'forks',
    fileParallelism: true,

    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],

    env: {
      NODE_ENV: 'test',
      // crypto.ts reads ENCRYPTION_KEY via env()
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      // env.ts requires these
      DATABASE_URL: 'postgresql://sentinel:sentinel@localhost:5432/sentinel_test',
      REDIS_URL: 'redis://localhost:6379/1',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long!!',
    },

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
});
