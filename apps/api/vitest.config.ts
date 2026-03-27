import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Integration tests for @sentinel/api.
 *
 * These tests hit real Postgres (sentinel_test DB) and may use a real or
 * mock Redis. Run `docker compose up postgres redis` before executing.
 *
 * Tests are serialized (fileParallelism: false) because they share a
 * single test database and clean tables between suites.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 30_000,

    // Integration tests share a database -- run sequentially.
    pool: 'forks',
    fileParallelism: false,

    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ],
    exclude: ['node_modules', 'dist'],

    setupFiles: ['./src/__tests__/setup.ts'],

    env: {
      NODE_ENV: 'test',
      PORT: '0', // Let the OS pick an available port during tests
      DATABASE_URL: 'postgresql://sentinel:sentinel@localhost:5432/sentinel_test',
      REDIS_URL: 'redis://localhost:6379/1',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long!!',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      SMTP_FROM: 'test@sentinel.dev',
    },

    resolve: {
      alias: {
        '@sentinel/shared': path.resolve(__dirname, '../../packages/shared/src'),
        '@sentinel/db': path.resolve(__dirname, '../../packages/db'),
      },
    },

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
  },
});
