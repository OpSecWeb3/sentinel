import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
    include: [
      'packages/*/src/**/__tests__/**/*.test.ts',
      'modules/*/src/**/__tests__/**/*.test.ts',
      'apps/*/src/**/__tests__/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://sentinel:sentinel@localhost:5434/sentinel_test',
      REDIS_URL: 'redis://localhost:6380/1',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long!!',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      SMTP_FROM: 'test@sentinel.dev',
    },
  },
  resolve: {
    alias: {
      '@sentinel/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@sentinel/db': path.resolve(__dirname, 'packages/db'),
      '@sentinel/notifications': path.resolve(__dirname, 'packages/notifications/src'),
    },
  },
});
