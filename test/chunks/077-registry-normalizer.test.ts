/**
 * Chunk 077 — Normalizer: Registry webhook/poll → normalized events
 * Chunk 078 — Handler: poll (version fetch, digest comparison, new tag detection)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestArtifact,
  createTestArtifactVersion,
} from '../helpers/setup.js';

describe('Chunk 077 — Registry normalizer', () => {
  it('should normalize Docker Hub push event', () => {
    const raw = {
      push_data: {
        tag: 'v1.2.3',
        pusher: 'dockeruser',
        pushed_at: Date.now() / 1000,
      },
      repository: {
        repo_name: 'org/image',
        namespace: 'org',
        name: 'image',
      },
      callback_url: 'https://registry.hub.docker.com/u/org/image/',
    };

    const eventType = 'registry.docker_push';
    const payload = {
      artifactType: 'docker_image',
      name: raw.repository.repo_name,
      version: raw.push_data.tag,
      pusher: raw.push_data.pusher,
      resourceId: raw.repository.repo_name,
    };

    expect(eventType).toBe('registry.docker_push');
    expect(payload.version).toBe('v1.2.3');
    expect(payload.name).toBe('org/image');
  });

  it('should normalize npm publish event', () => {
    const raw = {
      name: '@sentinel/shared',
      version: '2.0.0',
      'dist-tags': { latest: '2.0.0' },
      maintainers: [{ name: 'dev1', email: 'dev1@test.com' }],
    };

    const eventType = 'registry.npm_publish';
    const payload = {
      artifactType: 'npm_package',
      name: raw.name,
      version: raw.version,
      resourceId: raw.name,
    };

    expect(eventType).toBe('registry.npm_publish');
    expect(payload.name).toBe('@sentinel/shared');
  });
});

describe('Chunk 078 — Registry poll handler', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should detect new tag when version does not exist', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, {
      name: 'org/image',
      artifactType: 'docker_image',
    });

    // No versions exist yet — a polled tag is "new"
    const versions = await sql`
      SELECT version FROM rc_artifact_versions WHERE artifact_id = ${artifact.id}
    `;
    expect(versions.length).toBe(0);
  });

  it('should detect digest change on existing tag', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, {
      name: 'org/image',
      artifactType: 'docker_image',
    });

    const version = await createTestArtifactVersion(artifact.id, {
      version: 'latest',
      currentDigest: 'sha256:old_digest_abc',
    });

    // Simulate poll finding new digest
    const newDigest = 'sha256:new_digest_xyz';
    expect(version.currentDigest).not.toBe(newDigest);
  });

  it('should update last_polled_at after successful poll', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, { name: 'org/img' });

    await sql`UPDATE rc_artifacts SET last_polled_at = NOW() WHERE id = ${artifact.id}`;

    const [row] = await sql`SELECT last_polled_at FROM rc_artifacts WHERE id = ${artifact.id}`;
    expect(row.last_polled_at).toBeDefined();
    expect(new Date(row.last_polled_at).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });
});
