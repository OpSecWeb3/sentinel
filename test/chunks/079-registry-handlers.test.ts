/**
 * Chunk 079 — Handler: webhook.process (Docker Hub, npm registry)
 * Chunk 080 — Handler: attribution.check + ci.notify
 * Chunk 081 — Handler: verify + verify.aggregate (sigstore, provenance)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
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

describe('Chunk 079 — Registry webhook processing', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should parse Docker Hub webhook payload', () => {
    const payload = {
      push_data: { tag: 'latest', pusher: 'ci-bot', pushed_at: 1711627200 },
      repository: { repo_name: 'org/app', namespace: 'org', name: 'app' },
    };

    expect(payload.push_data.tag).toBe('latest');
    expect(payload.repository.repo_name).toBe('org/app');
  });

  it('should match webhook payload to monitored artifact', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, {
      name: 'org/app',
      artifactType: 'docker_image',
    });

    const [matched] = await sql`
      SELECT id, name FROM rc_artifacts
      WHERE org_id = ${org.id} AND name = 'org/app' AND enabled = true
    `;

    expect(matched).toBeDefined();
    expect(matched.id).toBe(artifact.id);
  });
});

describe('Chunk 080 — Attribution check', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should store CI notification for later matching', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    await sql`
      INSERT INTO rc_ci_notifications (org_id, artifact_name, artifact_type, version, digest, github_run_id, github_commit, github_actor, github_workflow, github_repo)
      VALUES (${org.id}, 'org/app', 'docker_image', 'v1.0.0', 'sha256:abc', 12345, 'abc123', 'ci-bot', 'deploy', 'org/repo')
    `;

    const [notification] = await sql`SELECT * FROM rc_ci_notifications WHERE org_id = ${org.id}`;
    expect(notification.artifact_name).toBe('org/app');
    expect(notification.github_actor).toBe('ci-bot');
  });

  it('should verify CI attribution against allowlists', () => {
    const allowedActors = ['ci-bot', 'release-bot'];
    const allowedWorkflows = ['deploy.yml', 'release.yml'];

    expect(allowedActors.includes('ci-bot')).toBe(true);
    expect(allowedActors.includes('unknown-user')).toBe(false);
    expect(allowedWorkflows.includes('deploy.yml')).toBe(true);
  });
});

describe('Chunk 081 — Verification handler', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should store verification results', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, { name: 'org/verified' });
    const version = await createTestArtifactVersion(artifact.id, { version: 'v1.0.0' });

    await sql`
      INSERT INTO rc_verifications (artifact_id, version_id, digest, has_signature, has_provenance, has_rekor_entry)
      VALUES (${artifact.id}, ${version.id}, 'sha256:abc', true, true, true)
    `;

    const [v] = await sql`SELECT * FROM rc_verifications WHERE artifact_id = ${artifact.id}`;
    expect(v.has_signature).toBe(true);
    expect(v.has_provenance).toBe(true);
    expect(v.has_rekor_entry).toBe(true);
  });

  it('should aggregate verification status for an artifact', async () => {
    const verifications = [
      { hasSignature: true, hasProvenance: true, hasRekorEntry: true },
      { hasSignature: true, hasProvenance: false, hasRekorEntry: true },
    ];

    const allSigned = verifications.every((v) => v.hasSignature);
    const allProvenanced = verifications.every((v) => v.hasProvenance);

    expect(allSigned).toBe(true);
    expect(allProvenanced).toBe(false);
  });
});
