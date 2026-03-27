import type { Job } from 'bullmq';
import { getDb, eq, sql, isNotNull } from '@sentinel/db';
import {
  organizations, slackInstallations, sessions,
} from '@sentinel/db/schema/core';
import { githubInstallations } from '@sentinel/db/schema/github';
import { rcArtifacts } from '@sentinel/db/schema/registry';
import { infraCdnProviderConfigs } from '@sentinel/db/schema/infra';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import { decrypt, encrypt, needsReEncrypt } from '@sentinel/shared/crypto';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';

const _log = rootLogger.child({ component: 'key-rotation' });

/**
 * Each target describes one encrypted column to re-encrypt.
 * The `table` must be a Drizzle table with an `id` column.
 */
interface RotationTarget {
  name: string;
  table: Parameters<ReturnType<typeof getDb>['select']>[0] extends never ? never : any;
  column: string;
}

const TARGETS: RotationTarget[] = [
  { name: 'organizations.inviteSecretEncrypted', table: organizations, column: 'inviteSecretEncrypted' },
  { name: 'organizations.webhookSecretEncrypted', table: organizations, column: 'webhookSecretEncrypted' },
  { name: 'slackInstallations.botToken', table: slackInstallations, column: 'botToken' },
  { name: 'githubInstallations.webhookSecretEncrypted', table: githubInstallations, column: 'webhookSecretEncrypted' },
  { name: 'rcArtifacts.credentialsEncrypted', table: rcArtifacts, column: 'credentialsEncrypted' },
  { name: 'infraCdnProviderConfigs.encryptedCredentials', table: infraCdnProviderConfigs, column: 'encryptedCredentials' },
  { name: 'awsIntegrations.credentialsEncrypted', table: awsIntegrations, column: 'credentialsEncrypted' },
];

const BATCH_SIZE = 100;

async function rotateColumn(target: RotationTarget): Promise<number> {
  const db = getDb();
  const tbl = target.table as any;
  const col = tbl[target.column];

  // Select rows where the encrypted column is non-null
  const rows: { id: string; value: string }[] = await db
    .select({ id: tbl.id, value: col })
    .from(tbl)
    .where(isNotNull(col))
    .limit(BATCH_SIZE);

  let rotated = 0;
  for (const row of rows) {
    if (!row.value || !needsReEncrypt(row.value)) continue;

    try {
      const plaintext = decrypt(row.value);
      const reEncrypted = encrypt(plaintext);

      await db
        .update(tbl)
        .set({ [target.column]: reEncrypted })
        .where(eq(tbl.id, row.id));

      rotated++;
    } catch (err) {
      _log.warn({ target: target.name, id: row.id, err }, 'Failed to re-encrypt row, skipping');
    }
  }

  return rotated;
}

async function rotateSessions(): Promise<number> {
  const db = getDb();
  const rows = await db.select().from(sessions).limit(BATCH_SIZE);

  let rotated = 0;
  for (const row of rows) {
    const sess = row.sess as Record<string, unknown> | null;
    if (!sess) continue;

    // Already encrypted with current format — check inner ciphertext
    if (typeof sess._encrypted === 'string') {
      if (!needsReEncrypt(sess._encrypted)) continue;

      try {
        const plaintext = decrypt(sess._encrypted);
        const reEncrypted = encrypt(plaintext);
        await db
          .update(sessions)
          .set({ sess: { _encrypted: reEncrypted } })
          .where(eq(sessions.sid, row.sid));
        rotated++;
      } catch (err) {
        _log.warn({ sid: row.sid, err }, 'Failed to re-encrypt session, skipping');
      }
    } else if (typeof sess.userId === 'string') {
      // Legacy plaintext session — encrypt it
      try {
        const encrypted = encrypt(JSON.stringify({ userId: sess.userId, orgId: sess.orgId, role: sess.role }));
        await db
          .update(sessions)
          .set({ sess: { _encrypted: encrypted } })
          .where(eq(sessions.sid, row.sid));
        rotated++;
      } catch (err) {
        _log.warn({ sid: row.sid, err }, 'Failed to encrypt legacy session, skipping');
      }
    }
  }

  return rotated;
}

export const keyRotationHandler: JobHandler = {
  jobName: 'platform.key.rotation',
  queueName: QUEUE_NAMES.DEFERRED,

  async process(_job: Job) {
    let totalRotated = 0;

    // Re-encrypt standard encrypted columns
    for (const target of TARGETS) {
      const count = await rotateColumn(target);
      if (count > 0) {
        _log.info({ target: target.name, rotated: count }, 'Re-encrypted rows');
      }
      totalRotated += count;
    }

    // Re-encrypt sessions
    const sessionCount = await rotateSessions();
    if (sessionCount > 0) {
      _log.info({ rotated: sessionCount }, 'Re-encrypted sessions');
    }
    totalRotated += sessionCount;

    if (totalRotated > 0) {
      _log.info({ totalRotated }, 'Key rotation batch complete');
    }
  },
};
