import type { Job } from 'bullmq';
import { getDb, eq, gt, asc, sql, isNotNull, and } from '@sentinel/db';
import {
  organizations, slackInstallations, sessions,
} from '@sentinel/db/schema/core';
import { githubInstallations } from '@sentinel/db/schema/github';
import { rcArtifacts } from '@sentinel/db/schema/registry';
import { infraCdnProviderConfigs } from '@sentinel/db/schema/infra';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import { decrypt, encrypt, needsReEncrypt, isKeyRotationActive } from '@sentinel/shared/crypto';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';

const _log = rootLogger.child({ component: 'key-rotation' });

/**
 * Each target describes one encrypted column to re-encrypt.
 * The `table` must be a Drizzle table with an `id` column.
 */
interface RotationTarget {
  name: string;
  table:
    | typeof organizations
    | typeof slackInstallations
    | typeof githubInstallations
    | typeof rcArtifacts
    | typeof infraCdnProviderConfigs
    | typeof awsIntegrations;
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

  let totalRotated = 0;
  let lastId = '';

  // Cursor-based pagination: use WHERE id > lastSeenId ORDER BY id ASC.
  // This avoids the O(offset) scan penalty of OFFSET-based pagination and
  // is stable under concurrent deletes (no rows are skipped or double-visited
  // when rows before the cursor are removed between batches).
  while (true) {
    const rows: { id: string; value: string }[] = await db
      .select({ id: tbl.id, value: col })
      .from(tbl)
      .where(lastId ? and(isNotNull(col), gt(tbl.id, lastId)) : isNotNull(col))
      .orderBy(asc(tbl.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    let batchRotated = 0;
    for (const row of rows) {
      if (!row.value || !needsReEncrypt(row.value)) continue;

      try {
        const plaintext = decrypt(row.value);
        const reEncrypted = encrypt(plaintext);

        const result = await db
          .update(tbl)
          .set({ [target.column]: reEncrypted })
          .where(and(eq(tbl.id, row.id), eq(col, row.value)));

        const rowCount = (result as any).rowCount ?? (result as any).count ?? 0;
        if (rowCount === 0) {
          _log.warn({ target: target.name, id: row.id }, 'Row modified concurrently during key rotation, will retry next cycle');
        } else {
          batchRotated++;
        }
      } catch (err) {
        _log.warn({ target: target.name, id: row.id, err }, 'Failed to re-encrypt row, skipping');
      }
    }

    totalRotated += batchRotated;
    lastId = rows[rows.length - 1].id;

    // If this batch was smaller than BATCH_SIZE we have reached the last page.
    if (rows.length < BATCH_SIZE) break;
  }

  return totalRotated;
}

async function rotateSessions(): Promise<number> {
  const db = getDb();

  // Filter at the SQL level to exclude sessions that are verifiably up to date:
  // a session is eligible for rotation if it is either—
  //   (a) a legacy plaintext session: the JSON object has no "_encrypted" key, OR
  //   (b) an already-encrypted session whose ciphertext may be stale (encrypted
  //       with the previous key): the JSON object has an "_encrypted" key.
  //
  // Case (b) cannot be further filtered at the SQL level because the schema
  // stores no key-version column; we must load the ciphertext and call
  // needsReEncrypt() to find out. We therefore page through all sessions that
  // have "_encrypted" set as well, accepting that some will be skipped as
  // already-current. Pagination prevents the batch from stalling indefinitely.
  //
  // Sessions with neither "_encrypted" nor "userId" are empty/unknown — they
  // will be loaded but skipped in the loop below, which is harmless.

  // Two passes in priority order:
  //   1. Legacy sessions (no _encrypted key) — these always need work.
  //   2. Encrypted sessions (have _encrypted key) — may or may not need re-key.

  let totalRotated = 0;

  // --- Pass 1: legacy plaintext sessions ---
  // WHERE NOT (sess ? '_encrypted')
  // Cursor-based pagination using sid (text PK, ordered ASC).
  {
    let lastSid = '';
    while (true) {
      const rows = await db
        .select()
        .from(sessions)
        .where(lastSid
          ? and(sql`NOT (${sessions.sess} ? '_encrypted')`, gt(sessions.sid, lastSid))
          : sql`NOT (${sessions.sess} ? '_encrypted')`)
        .orderBy(asc(sessions.sid))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      let batchRotated = 0;
      for (const row of rows) {
        const sess = row.sess as Record<string, unknown> | null;
        if (!sess || typeof sess.userId !== 'string') continue;

        try {
          const encrypted = encrypt(JSON.stringify({ userId: sess.userId, orgId: sess.orgId, role: sess.role }));
          await db
            .update(sessions)
            .set({ sess: { _encrypted: encrypted } })
            .where(eq(sessions.sid, row.sid));
          batchRotated++;
        } catch (err) {
          _log.warn({ sid: row.sid, err }, 'Failed to encrypt legacy session, skipping');
        }
      }

      totalRotated += batchRotated;
      lastSid = rows[rows.length - 1].sid;
      if (rows.length < BATCH_SIZE) break;
    }
  }

  // --- Pass 2: already-encrypted sessions that may need re-keying ---
  // WHERE sess ? '_encrypted'
  // Cursor-based pagination using sid (text PK, ordered ASC).
  {
    let lastSid = '';
    while (true) {
      const rows = await db
        .select()
        .from(sessions)
        .where(lastSid
          ? and(sql`${sessions.sess} ? '_encrypted'`, gt(sessions.sid, lastSid))
          : sql`${sessions.sess} ? '_encrypted'`)
        .orderBy(asc(sessions.sid))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      let batchRotated = 0;
      for (const row of rows) {
        const sess = row.sess as Record<string, unknown> | null;
        if (!sess || typeof sess._encrypted !== 'string') continue;

        if (!needsReEncrypt(sess._encrypted)) continue;

        try {
          const plaintext = decrypt(sess._encrypted);
          const reEncrypted = encrypt(plaintext);
          await db
            .update(sessions)
            .set({ sess: { _encrypted: reEncrypted } })
            .where(eq(sessions.sid, row.sid));
          batchRotated++;
        } catch (err) {
          _log.warn({ sid: row.sid, err }, 'Failed to re-encrypt session, skipping');
        }
      }

      totalRotated += batchRotated;
      lastSid = rows[rows.length - 1].sid;
      if (rows.length < BATCH_SIZE) break;
    }
  }

  return totalRotated;
}

export const keyRotationHandler: JobHandler = {
  jobName: 'platform.key.rotation',
  queueName: QUEUE_NAMES.DEFERRED,
  async process(_job: Job) {
    // Short-circuit: if ENCRYPTION_KEY_PREV is not set, no key rotation is in
    // progress and all versioned ciphertexts are already encrypted with the
    // current key. This avoids full table scans across 7+ tables every 5 min
    // when no rotation has occurred (Bug M28).
    if (!isKeyRotationActive()) {
      return;
    }

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
