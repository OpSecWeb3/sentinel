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
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'modules/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts', '**/*.spec.ts',
        '**/__tests__/**', '**/dist/**', '**/node_modules/**',
        'apps/web/src/**',
        'packages/shared/src/module.ts',
        'packages/shared/src/rules.ts',
        'packages/shared/src/hono-types.ts',
        'packages/shared/src/index.ts',
        'packages/db/src/seed/**',
      ],
      thresholds: {
        lines: 49,
        functions: 62,
        branches: 79,
        statements: 49,
      },
    },
    include: [
      'packages/*/src/**/__tests__/**/*.test.ts',
      'modules/*/src/**/__tests__/**/*.test.ts',
      'apps/*/src/**/__tests__/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@localhost:5434/sentinel_test',
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6380/1',
      SESSION_SECRET: process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long!!',
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',
      SMTP_FROM: process.env.SMTP_FROM || 'test@sentinel.dev',
      SMTP_URL: process.env.SMTP_URL || 'smtp://localhost:1025',
      DISABLE_RATE_LIMIT: process.env.DISABLE_RATE_LIMIT || 'true',
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
