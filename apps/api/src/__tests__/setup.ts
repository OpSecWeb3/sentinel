/**
 * API test setup shim.
 *
 * Keep this file as a thin wrapper so `apps/api/vitest.config.ts` and local
 * tests can continue importing `./setup.js`, while all lifecycle hooks and
 * helpers come from the shared integration harness.
 */

export {
  cleanTables,
  cleanSpecificTables,
  getTestDb,
  getTestSql,
  getTestRedis,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestUserWithOrg,
  createTestApiKey,
  createTestDetection,
  createTestRule,
  createTestEvent,
  createTestNotificationChannel,
  createTestSession,
  signWebhookPayload,
  createTestArtifact,
  createTestArtifactVersion,
  createTestGithubInstallation,
  createTestGithubRepo,
} from '../../../../test/helpers/setup.js';
