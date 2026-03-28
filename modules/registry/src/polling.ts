/**
 * Release-chain polling service.
 *
 * Checks Docker Hub tags API for digest changes and npm registry for new
 * versions. Compares against stored state and produces normalized events
 * when changes are detected.
 *
 * Ported from Verity's polling.service.ts into Sentinel patterns.
 */
import { logger as rootLogger } from '@sentinel/shared/logger';
import { getDb } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import {
  rcArtifacts,
  rcArtifactEvents,
  rcArtifactVersions,
} from '@sentinel/db/schema/registry';
import { eq, and } from '@sentinel/db';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { decrypt } from '@sentinel/shared/crypto';
import { normalizePollChange, type PollChangeType } from './normalizer.js';
import { minimatch } from 'minimatch';

const log = rootLogger.child({ component: 'registry-polling' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitoredArtifact {
  id: string;
  orgId: string;
  name: string;
  registry: 'docker_hub' | 'npmjs';
  enabled: boolean;
  tagPatterns: string[];
  ignorePatterns: string[];
  pollIntervalSeconds: number;
  lastPolledAt: Date | null;
  storedVersions: Map<string, StoredVersion>;
  metadata: Record<string, unknown>;
  credentialsEncrypted?: string | null;
  watchMode: 'dist-tags' | 'versions';
}

export interface StoredVersion {
  id: string;
  tag: string;
  currentDigest: string | null;
  status: 'active' | 'gone' | 'untracked';
  metadata: Record<string, unknown>;
}

export interface RemoteVersion {
  name: string;
  digest: string | null;
  metadata?: Record<string, unknown>;
}

export interface RegistryFetchResult {
  versions: RemoteVersion[];
  artifactMetadata?: Record<string, unknown>;
  totalCount: number | null;
  pagesUsed: number;
}

export interface MetadataChange {
  eventType: PollChangeType;
  version: string;
  oldDigest: string | null;
  newDigest: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full scan scheduling
// ---------------------------------------------------------------------------

/** Full scan for removals runs every Nth poll cycle per artifact. */
const FULL_SCAN_EVERY_N_POLLS = 10;

/** npm dist-tags mode: full scans every 6 hours. */
const FULL_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// WARNING: These Maps are process-local. Under a multi-worker deployment each
// worker maintains its own copy. Full-scan scheduling (FULL_SCAN_EVERY_N_POLLS
// and FULL_SCAN_INTERVAL_MS) is driven by pollCount / lastFullScanAt persisted
// in rcArtifacts.metadata, which is read from the DB at the start of every
// poll call so that all workers share the same authoritative state.
// Do NOT rely on these Maps as a cache across poll cycles — they exist only to
// satisfy resetFullScanTracking() in tests.
const pollCounts = new Map<string, number>();
const lastFullScanAt = new Map<string, number>();

export function resetFullScanTracking(): void {
  pollCounts.clear();
  lastFullScanAt.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely enqueue a job. Returns true on success, false if queue unavailable.
 */
async function safeEnqueue(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
  opts?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const queue = getQueue(queueName);
    await queue.add(jobName, data, opts);
    return true;
  } catch (err) {
    log.error({ err, jobName }, 'Failed to enqueue job');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchTagPattern(
  tag: string,
  watchPatterns: string[],
  ignorePatterns: string[],
): boolean {
  const included = watchPatterns.some((p) => minimatch(tag, p));
  if (!included) return false;
  const excluded = ignorePatterns.some((p) => minimatch(tag, p));
  return !excluded;
}

// ---------------------------------------------------------------------------
// Semver parsing
// ---------------------------------------------------------------------------

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

// ---------------------------------------------------------------------------
// Docker Hub API
// ---------------------------------------------------------------------------

const DOCKER_HUB_BASE = 'https://hub.docker.com/v2';

interface DockerHubTag {
  name: string;
  digest: string;
  last_updated: string;
  images: Array<{ digest: string; architecture: string; os: string }>;
}

export async function fetchDockerHubTags(
  repoName: string,
  lastPolledAt: Date | null,
  _isFullScan: boolean,
  token?: string,
): Promise<RegistryFetchResult> {
  const versions: RemoteVersion[] = [];
  let totalCount: number | null = null;
  let pagesUsed = 0;
  const pageSize = 100;
  const maxPages = 10;

  let url: string | null =
    `${DOCKER_HUB_BASE}/repositories/${repoName}/tags?page_size=${pageSize}&ordering=last_updated`;

  const fetchHeaders: Record<string, string> = {};
  if (token) {
    fetchHeaders['Authorization'] = `Bearer ${token}`;
  }

  while (url && pagesUsed < maxPages) {
    const response = await fetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Docker Hub API returned ${response.status} for ${repoName}`);
    }

    const data = (await response.json()) as {
      count: number;
      next: string | null;
      results: DockerHubTag[];
    };

    if (pagesUsed === 0) totalCount = data.count;
    pagesUsed++;

    for (const tag of data.results) {
      // For incremental polls, stop when we hit tags older than last poll
      if (
        lastPolledAt &&
        !_isFullScan &&
        new Date(tag.last_updated) < lastPolledAt
      ) {
        url = null;
        break;
      }

      versions.push({
        name: tag.name,
        digest: tag.digest ?? tag.images?.[0]?.digest ?? null,
        metadata: {
          lastUpdated: tag.last_updated,
          images: tag.images?.map((i) => ({
            digest: i.digest,
            architecture: i.architecture,
            os: i.os,
          })),
        },
      });
    }

    if (url !== null) {
      url = data.next;
    }
  }

  return { versions, totalCount, pagesUsed };
}

// ---------------------------------------------------------------------------
// npm Registry API
// ---------------------------------------------------------------------------

const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

export async function fetchNpmVersions(
  packageName: string,
  lastPolledAt: Date | null,
  isFullScan: boolean,
  token?: string,
): Promise<RegistryFetchResult> {
  // For incremental polls, use the abbreviated metadata endpoint.
  // Abbreviated responses only contain: name, dist-tags, modified, and
  // versions[].dist (shasum/integrity). They do NOT include: time,
  // maintainers, license, description, deprecated, or scripts.
  const headers: Record<string, string> = isFullScan
    ? {}
    : { Accept: 'application/vnd.npm.install-v1+json' };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${packageName}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const versions: RemoteVersion[] = [];
  const versionMap = (data.versions ?? {}) as Record<string, Record<string, unknown>>;
  const distTags = (data['dist-tags'] ?? {}) as Record<string, string>;

  if (isFullScan) {
    // Full packument: time, maintainers, license, description are available.
    const time = (data.time ?? {}) as Record<string, string>;

    for (const [versionName, versionData] of Object.entries(versionMap)) {
      const publishedAt = time[versionName] ? new Date(time[versionName]) : null;
      if (lastPolledAt && publishedAt && publishedAt < lastPolledAt) {
        continue;
      }

      const dist = (versionData.dist ?? {}) as Record<string, unknown>;
      versions.push({
        name: versionName,
        digest: (dist.shasum as string) ?? (dist.integrity as string) ?? null,
        metadata: {
          version: versionName,
          deprecated: versionData.deprecated ?? null,
          publishedAt: time[versionName] ?? null,
          distTags: Object.entries(distTags)
            .filter(([, v]) => v === versionName)
            .map(([tag]) => tag),
        },
      });
    }

    // Build artifact-level metadata (only available on full scans)
    const maintainers = (data.maintainers ?? []) as Array<{ name: string; email?: string }>;
    const artifactMetadata: Record<string, unknown> = {
      distTags,
      maintainers,
      license: data.license,
      description: data.description,
    };

    return {
      versions,
      artifactMetadata,
      totalCount: versions.length,
      pagesUsed: 1,
    };
  }

  // Abbreviated packument: only dist-tags and versions[].dist are reliable.
  // Cannot filter by timestamp (no `time` field), so return all version keys
  // and let the caller deduplicate against stored versions.
  for (const [versionName, versionData] of Object.entries(versionMap)) {
    const dist = (versionData.dist ?? {}) as Record<string, unknown>;
    versions.push({
      name: versionName,
      digest: (dist.shasum as string) ?? (dist.integrity as string) ?? null,
      metadata: {
        version: versionName,
        distTags: Object.entries(distTags)
          .filter(([, v]) => v === versionName)
          .map(([tag]) => tag),
      },
    });
  }

  // No artifactMetadata on abbreviated polls — maintainers, license,
  // and description are not present in the abbreviated response.
  // Returning only distTags (which IS available) so dist-tag change
  // detection still works on incremental polls.
  return {
    versions,
    artifactMetadata: { distTags },
    totalCount: versions.length,
    pagesUsed: 1,
  };
}

// ---------------------------------------------------------------------------
// npm dist-tags fetch (for watchMode: 'dist-tags')
// ---------------------------------------------------------------------------

export async function fetchNpmDistTags(
  packageName: string,
  isFullScan: boolean,
  token?: string,
): Promise<RegistryFetchResult> {
  const headers: Record<string, string> = isFullScan
    ? {}
    : { Accept: 'application/vnd.npm.install-v1+json' };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${packageName}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const distTags = (data['dist-tags'] ?? {}) as Record<string, string>;
  const versionMap = (data.versions ?? {}) as Record<string, Record<string, unknown>>;
  const versions: RemoteVersion[] = [];

  for (const [tagName, resolvedVersion] of Object.entries(distTags)) {
    const versionData = versionMap[resolvedVersion];
    const dist = (versionData?.dist ?? {}) as Record<string, unknown>;
    const shasum = (dist.shasum as string) ?? (dist.integrity as string) ?? null;

    versions.push({
      name: tagName,
      digest: shasum,
      metadata: {
        distTag: tagName,
        resolvedVersion,
      },
    });
  }

  const artifactMetadata: Record<string, unknown> = { distTags };
  if (isFullScan) {
    const maintainers = (data.maintainers ?? []) as Array<{ name: string; email?: string }>;
    artifactMetadata.maintainers = maintainers;
    artifactMetadata.license = data.license;
    artifactMetadata.description = data.description;
  }

  return {
    versions,
    artifactMetadata,
    totalCount: versions.length,
    pagesUsed: 1,
  };
}

// ---------------------------------------------------------------------------
// npm dist-tags poll logic
// ---------------------------------------------------------------------------

async function pollNpmDistTags(
  artifact: MonitoredArtifact,
  isFullScan: boolean,
  token?: string,
): Promise<void> {
  const {
    id: artifactId,
    orgId,
    name,
    tagPatterns,
    ignorePatterns,
    storedVersions,
    metadata: storedMetadata,
  } = artifact;

  const db = getDb();

  log.info({ artifact: name, mode: isFullScan ? 'full' : 'incremental', watchMode: 'dist-tags' }, 'Polling npm dist-tags');

  let result: RegistryFetchResult;
  try {
    result = await fetchNpmDistTags(name, isFullScan, token);
    log.debug({ artifact: name, tagCount: result.versions.length }, 'Fetched dist-tags');
  } catch (err) {
    log.error({ err, artifact: name }, 'Failed to fetch npm dist-tags');
    return;
  }

  const remoteTagNames = new Set<string>();

  for (const remoteTag of result.versions) {
    const tagName = remoteTag.name;
    remoteTagNames.add(tagName);

    if (!matchTagPattern(tagName, tagPatterns, ignorePatterns)) {
      continue;
    }

    const digest = remoteTag.digest;
    const local = storedVersions.get(tagName);

    if (!local) {
      // New dist-tag appeared
      const changeType: PollChangeType = 'npm.new_tag';

      const enrichedPayload: Record<string, unknown> = {
        artifact: name,
        registry: 'npmjs',
        tag: tagName,
        oldDigest: null,
        newDigest: digest,
        ...(remoteTag.metadata ?? {}),
      };

      const [versionRow] = await db
        .insert(rcArtifactVersions)
        .values({
          artifactId,
          version: tagName,
          currentDigest: digest,
          status: 'active',
          metadata: remoteTag.metadata ?? {},
        })
        .returning();

      if (digest) {
        const normalized = normalizePollChange(changeType, enrichedPayload, orgId);
        const [event] = await db.insert(events).values(normalized).returning();

        await db.insert(rcArtifactEvents).values({
          eventId: event.id,
          artifactId,
          versionId: versionRow.id,
          artifactEventType: 'new_tag',
          version: tagName,
          oldDigest: null,
          newDigest: digest,
          source: 'poll',
          metadata: enrichedPayload,
        });

        await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

        await safeEnqueue(
          QUEUE_NAMES.DEFERRED,
          'registry.attribution',
          { eventId: event.id, artifactName: name, tag: tagName, digest },
          { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
        );
      }

      log.info({ artifact: name, tag: tagName, hasDigest: !!digest }, 'New dist-tag discovered');
    } else if (digest && local.currentDigest !== digest) {
      // Dist-tag pointer moved (resolved version changed)
      const changeType: PollChangeType = 'npm.dist_tag_updated';

      const enrichedPayload: Record<string, unknown> = {
        artifact: name,
        registry: 'npmjs',
        tag: tagName,
        oldDigest: local.currentDigest,
        newDigest: digest,
        ...(remoteTag.metadata ?? {}),
      };

      const normalized = normalizePollChange(changeType, enrichedPayload, orgId);
      const [event] = await db.insert(events).values(normalized).returning();

      await db
        .update(rcArtifactVersions)
        .set({
          currentDigest: digest,
          digestChangedAt: new Date(),
          metadata: remoteTag.metadata ?? {},
        })
        .where(eq(rcArtifactVersions.id, local.id));

      await db.insert(rcArtifactEvents).values({
        eventId: event.id,
        artifactId,
        versionId: local.id,
        artifactEventType: 'dist_tag_updated',
        version: tagName,
        oldDigest: local.currentDigest,
        newDigest: digest,
        source: 'poll',
        metadata: enrichedPayload,
      });

      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

      await safeEnqueue(
        QUEUE_NAMES.DEFERRED,
        'registry.attribution',
        { eventId: event.id, artifactName: name, tag: tagName, digest },
        { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
      );

      log.info({ artifact: name, tag: tagName }, 'Dist-tag pointer changed');
    }
  }

  // Removal detection (full scans only)
  if (isFullScan) {
    for (const [tagName, local] of storedVersions) {
      if (local.status !== 'active') continue;
      if (remoteTagNames.has(tagName)) continue;

      const changeType: PollChangeType = 'npm.tag_removed';

      const normalized = normalizePollChange(
        changeType,
        {
          artifact: name,
          registry: 'npmjs',
          tag: tagName,
          oldDigest: local.currentDigest,
          newDigest: null,
        },
        orgId,
      );

      const [event] = await db.insert(events).values(normalized).returning();

      await db
        .update(rcArtifactVersions)
        .set({ status: 'gone' })
        .where(eq(rcArtifactVersions.id, local.id));

      await db.insert(rcArtifactEvents).values({
        eventId: event.id,
        artifactId,
        versionId: local.id,
        artifactEventType: 'tag_removed',
        version: tagName,
        oldDigest: local.currentDigest,
        newDigest: null,
        source: 'poll',
      });

      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

      log.info({ artifact: name, tag: tagName }, 'Dist-tag removed');
    }
  }

  // Metadata changes (maintainers, full scan only)
  if (isFullScan && result.artifactMetadata && Object.keys(storedMetadata).length > 0) {
    const metaChanges = detectMetadataChanges(storedMetadata, result.artifactMetadata);

    for (const change of metaChanges) {
      const normalized = normalizePollChange(
        change.eventType,
        {
          artifact: name,
          registry: 'npmjs',
          tag: change.version,
          oldDigest: change.oldDigest,
          newDigest: change.newDigest,
          ...change.metadata,
        },
        orgId,
      );

      const [event] = await db.insert(events).values(normalized).returning();
      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

      log.info({ artifact: name, eventType: change.eventType, version: change.version }, 'Metadata change detected');
    }
  }

  // Update lastPolledAt and metadata
  const count = (pollCounts.get(artifactId) ?? 0) + 1;
  pollCounts.set(artifactId, count);
  if (isFullScan) {
    lastFullScanAt.set(artifactId, Date.now());
  }

  try {
    await db
      .update(rcArtifacts)
      .set({
        lastPolledAt: new Date(),
        metadata: {
          ...storedMetadata,
          ...(result.artifactMetadata ?? {}),
          pollCount: count,
          lastFullScanAt: lastFullScanAt.get(artifactId) ?? null,
        },
      })
      .where(eq(rcArtifacts.id, artifactId));
  } catch (err) {
    log.warn({ err, artifact: name }, 'Failed to update rcArtifacts metadata');
  }
}

// ---------------------------------------------------------------------------
// Change detection: metadata changes (npm maintainers, dist-tags)
// ---------------------------------------------------------------------------

export function detectMetadataChanges(
  storedMetadata: Record<string, unknown>,
  newMetadata: Record<string, unknown>,
): MetadataChange[] {
  const changes: MetadataChange[] = [];

  // Maintainer changes — only compare when maintainers data is present in
  // the new metadata. Abbreviated npm responses omit maintainers entirely,
  // so we skip this check to avoid false "all maintainers removed" alerts.
  if ('maintainers' in newMetadata) {
    const oldMaintainers = (storedMetadata.maintainers as Array<{ name: string }>) ?? [];
    const newMaintainers = (newMetadata.maintainers as Array<{ name: string }>) ?? [];
    const oldNames = new Set(oldMaintainers.map((m) => m.name));
    const newNames = new Set(newMaintainers.map((m) => m.name));

    const added = newMaintainers.filter((m) => !oldNames.has(m.name));
    const removed = oldMaintainers.filter((m) => !newNames.has(m.name));

    if (added.length > 0 || removed.length > 0) {
      changes.push({
        eventType: 'npm.maintainer_changed',
        version: '*',
        oldDigest: null,
        newDigest: null,
        metadata: {
          added: added.map((m) => m.name),
          removed: removed.map((m) => m.name),
          currentMaintainers: newMaintainers.map((m) => m.name),
        },
      });
    }
  }

  // Dist-tag changes
  const oldDistTags = (storedMetadata.distTags as Record<string, string>) ?? {};
  const newDistTags = (newMetadata.distTags as Record<string, string>) ?? {};

  for (const [tag, version] of Object.entries(newDistTags)) {
    if (oldDistTags[tag] && oldDistTags[tag] !== version) {
      changes.push({
        eventType: 'npm.dist_tag_updated',
        version: tag,
        oldDigest: null,
        newDigest: null,
        metadata: {
          distTag: tag,
          oldVersion: oldDistTags[tag],
          newVersion: version,
        },
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Change detection: version deprecation (npm)
// ---------------------------------------------------------------------------

export function detectDeprecations(
  localVersions: Map<string, StoredVersion>,
  remoteVersions: Map<string, Record<string, unknown>>,
): MetadataChange[] {
  const changes: MetadataChange[] = [];

  for (const [versionName, remoteData] of remoteVersions) {
    const local = localVersions.get(versionName);
    if (!local) continue;

    const localMeta = local.metadata ?? {};
    const wasDeprecated = localMeta.deprecated as string | null;
    const nowDeprecated = remoteData.deprecated as string | null;

    if (!wasDeprecated && nowDeprecated) {
      changes.push({
        eventType: 'npm.version_deprecated',
        version: versionName,
        oldDigest: local.currentDigest,
        newDigest: local.currentDigest,
        metadata: { deprecationMessage: nowDeprecated },
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Core poll logic for a single artifact
// ---------------------------------------------------------------------------

export async function pollArtifact(artifact: MonitoredArtifact): Promise<void> {
  const {
    id: artifactId,
    orgId,
    name,
    registry,
    tagPatterns,
    ignorePatterns,
    lastPolledAt,
    storedVersions,
    metadata: storedMetadata,
  } = artifact;

  const db = getDb();

  // Always load poll tracking state from the DB so that all workers share the
  // same authoritative counters. Using the in-memory Map as a cache would let
  // each worker diverge and cause full scans to fire N times under N workers.
  {
    const [dbArtifact] = await db
      .select({ metadata: rcArtifacts.metadata })
      .from(rcArtifacts)
      .where(eq(rcArtifacts.id, artifactId))
      .limit(1);
    const meta = (dbArtifact?.metadata as Record<string, unknown>) ?? {};
    pollCounts.set(artifactId, (meta.pollCount as number) ?? 0);
    if (meta.lastFullScanAt) {
      lastFullScanAt.set(artifactId, meta.lastFullScanAt as number);
    } else {
      lastFullScanAt.delete(artifactId);
    }
  }

  // Determine if this should be a full scan
  const count = (pollCounts.get(artifactId) ?? 0) + 1;
  pollCounts.set(artifactId, count);
  const isFirstPoll = !lastPolledAt;

  let isFullScan: boolean;
  if (registry === 'npmjs') {
    const lastFull = lastFullScanAt.get(artifactId) ?? 0;
    isFullScan = isFirstPoll || Date.now() - lastFull >= FULL_SCAN_INTERVAL_MS;
  } else {
    isFullScan = isFirstPoll || count % FULL_SCAN_EVERY_N_POLLS === 0;
  }

  if (isFullScan) {
    lastFullScanAt.set(artifactId, Date.now());
  }

  log.info({ artifact: name, registry, mode: isFullScan ? 'full' : 'incremental' }, 'Polling artifact');

  // Decrypt registry credentials if present
  interface RegistryCredentials {
    dockerUsername?: string;
    dockerToken?: string;
    npmToken?: string;
  }
  let credentials: RegistryCredentials = {};
  if (artifact.credentialsEncrypted) {
    try {
      credentials = JSON.parse(decrypt(artifact.credentialsEncrypted)) as RegistryCredentials;
    } catch (err) {
      log.warn({ err, artifact: name }, 'Failed to decrypt artifact credentials — polling without auth');
    }
  }

  // Dist-tags mode: use dedicated poll function for npm dist-tag watching
  if (registry === 'npmjs' && artifact.watchMode === 'dist-tags') {
    return pollNpmDistTags(artifact, isFullScan, credentials.npmToken);
  }

  // Fetch from registry
  let result: RegistryFetchResult;
  try {
    if (registry === 'docker_hub') {
      let dockerToken: string | undefined;
      if (credentials.dockerUsername && credentials.dockerToken) {
        try {
          const loginRes = await fetch('https://hub.docker.com/v2/users/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: credentials.dockerUsername, password: credentials.dockerToken }),
            signal: AbortSignal.timeout(30_000),
          });
          if (loginRes.ok) {
            const loginData = (await loginRes.json()) as { token?: string };
            dockerToken = loginData.token;
          } else {
            log.warn({ artifact: name, status: loginRes.status }, 'Docker Hub login failed — polling without auth');
          }
        } catch (err) {
          log.warn({ err, artifact: name }, 'Docker Hub login request failed — polling without auth');
        }
      }
      result = await fetchDockerHubTags(name, lastPolledAt, isFullScan, dockerToken);
    } else {
      result = await fetchNpmVersions(name, lastPolledAt, isFullScan, credentials.npmToken);
    }

    log.debug({ artifact: name, versionCount: result.versions.length, pagesUsed: result.pagesUsed }, 'Fetched versions');
  } catch (err) {
    log.error({ err, artifact: name }, 'Failed to fetch versions');
    return;
  }

  const remoteVersionNames = new Set<string>();
  const remoteVersionMeta = new Map<string, Record<string, unknown>>();

  // -- Process version-level changes ----------------------------------------

  for (const remoteVersion of result.versions) {
    const versionName = remoteVersion.name;
    remoteVersionNames.add(versionName);
    if (remoteVersion.metadata) {
      remoteVersionMeta.set(versionName, remoteVersion.metadata);
    }

    if (!matchTagPattern(versionName, tagPatterns, ignorePatterns)) {
      continue;
    }

    const digest = remoteVersion.digest;
    // NOTE: digest may be null for some npm packages at publish time — the
    // registry occasionally returns a version entry before the shasum/integrity
    // fields are populated.  We must NOT skip these versions entirely:
    // if we skip them now and the digest is added later, the next poll will
    // see an "unknown" version and fire a false `new_version` alert.
    // Instead, we store the version immediately with digest=null so that the
    // version is already known.  Digest changes are detected only when both
    // the stored and incoming digests are non-null.

    const local = storedVersions.get(versionName);

    if (!local) {
      // New version/tag — store it regardless of whether a digest is present.
      // Only fire the alert when we have a digest; versions without one are
      // recorded silently so a later digest population does not look "new".
      const changeType: PollChangeType =
        registry === 'docker_hub' ? 'docker.new_tag' : 'npm.version_published';

      let enrichedPayload: Record<string, unknown> = {
        artifact: name,
        registry,
        tag: versionName,
        oldDigest: null,
        newDigest: digest,
        ...(remoteVersion.metadata ?? {}),
      };

      // Major version jump detection (npm)
      if (registry === 'npmjs' && storedVersions.size > 0) {
        const newSemver = parseSemver(versionName);
        if (newSemver) {
          let maxMajor = -1;
          let maxVersion = '';
          for (const [existingName] of storedVersions) {
            const existing = parseSemver(existingName);
            if (existing && existing[0] > maxMajor) {
              maxMajor = existing[0];
              maxVersion = existingName;
            }
          }
          if (maxMajor >= 0 && newSemver[0] > maxMajor) {
            enrichedPayload = {
              ...enrichedPayload,
              isMajorVersionJump: true,
              previousVersion: maxVersion,
            };
          }
        }
      }

      // Fix #5: Insert into rcArtifactEvents and upsert rcArtifactVersions.
      // Always persist the version row (with digest=null if unavailable) so
      // subsequent polls recognise it as an already-known version.
      const [versionRow] = await db
        .insert(rcArtifactVersions)
        .values({
          artifactId,
          version: versionName,
          currentDigest: digest,   // null is fine — stored as-is
          status: 'active',
          metadata: remoteVersion.metadata ?? {},
        })
        .returning();

      // Only emit an event and enqueue downstream jobs when we have a digest.
      // Without a digest the version is "known but unverified"; we'll catch
      // the digest on the next poll and emit a digest_change event then.
      if (digest) {
        const normalized = normalizePollChange(changeType, enrichedPayload, orgId);
        const [event] = await db.insert(events).values(normalized).returning();

        await db.insert(rcArtifactEvents).values({
          eventId: event.id,
          artifactId,
          versionId: versionRow.id,
          artifactEventType: changeType.replace(/^(?:docker|npm)\./, ''),
          version: versionName,
          oldDigest: null,
          newDigest: digest,
          source: 'poll',
          metadata: enrichedPayload,
        });

        await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

        // Schedule deferred attribution check (5 min grace period)
        await safeEnqueue(
          QUEUE_NAMES.DEFERRED,
          'registry.attribution',
          { eventId: event.id, artifactName: name, tag: versionName, digest },
          { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
        );

        // Fix #8: Enqueue verification job for new versions
        await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.verify', {
          artifactId,
          versionId: versionRow.id,
          artifactType: registry === 'docker_hub' ? 'docker_image' : 'npm_package',
          artifactName: name,
          version: versionName,
          digest,
          eventId: event.id,
        });
      }

      log.info({ artifact: name, version: versionName, hasDigest: !!digest }, 'New version discovered');
    } else if (digest && local.currentDigest !== digest) {
      // Content changed (digest change)
      const changeType: PollChangeType =
        registry === 'docker_hub' ? 'docker.digest_change' : 'npm.version_published';

      const enrichedPayload: Record<string, unknown> = {
        artifact: name,
        registry,
        tag: versionName,
        oldDigest: local.currentDigest,
        newDigest: digest,
        ...(remoteVersion.metadata ?? {}),
      };

      const normalized = normalizePollChange(changeType, enrichedPayload, orgId);
      const [event] = await db.insert(events).values(normalized).returning();

      // Fix #9: Update rcArtifactVersions with new digest
      await db
        .update(rcArtifactVersions)
        .set({
          currentDigest: digest,
          digestChangedAt: new Date(),
          metadata: remoteVersion.metadata ?? {},
        })
        .where(eq(rcArtifactVersions.id, local.id));

      // Fix #5: Insert into rcArtifactEvents
      await db.insert(rcArtifactEvents).values({
        eventId: event.id,
        artifactId,
        versionId: local.id,
        artifactEventType: changeType.replace(/^(?:docker|npm)\./, ''),
        version: versionName,
        oldDigest: local.currentDigest,
        newDigest: digest,
        source: 'poll',
        metadata: enrichedPayload,
      });

      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

      // Schedule deferred attribution check
      await safeEnqueue(
        QUEUE_NAMES.DEFERRED,
        'registry.attribution',
        { eventId: event.id, artifactName: name, tag: versionName, digest },
        { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
      );

      // Fix #8: Enqueue verification job for digest changes
      await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.verify', {
        artifactId,
        versionId: local.id,
        artifactType: registry === 'docker_hub' ? 'docker_image' : 'npm_package',
        artifactName: name,
        version: versionName,
        digest,
        eventId: event.id,
      });

      log.info({ artifact: name, version: versionName }, 'Digest change detected');
    }
  }

  // -- Removal detection (full scans only) ----------------------------------

  if (isFullScan) {
    const sawAllVersions =
      result.totalCount !== null && result.versions.length >= result.totalCount;

    for (const [versionName, local] of storedVersions) {
      if (local.status !== 'active') continue;
      if (remoteVersionNames.has(versionName)) continue;

      if (sawAllVersions) {
        const changeType: PollChangeType =
          registry === 'docker_hub' ? 'docker.tag_removed' : 'npm.version_unpublished';

        const normalized = normalizePollChange(
          changeType,
          {
            artifact: name,
            registry,
            tag: versionName,
            oldDigest: local.currentDigest,
            newDigest: null,
          },
          orgId,
        );

        const [event] = await db.insert(events).values(normalized).returning();

        // Fix #9: Mark version as 'gone' in rcArtifactVersions
        await db
          .update(rcArtifactVersions)
          .set({ status: 'gone' })
          .where(eq(rcArtifactVersions.id, local.id));

        // Fix #5: Insert into rcArtifactEvents
        await db.insert(rcArtifactEvents).values({
          eventId: event.id,
          artifactId,
          versionId: local.id,
          artifactEventType: changeType.replace(/^(?:docker|npm)\./, ''),
          version: versionName,
          oldDigest: local.currentDigest,
          newDigest: null,
          source: 'poll',
        });

        await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

        log.info({ artifact: name, version: versionName }, 'Version removed');
      }
    }
  }

  // -- Artifact-level metadata changes (npm) --------------------------------

  if (
    result.artifactMetadata &&
    Object.keys(storedMetadata).length > 0 &&
    registry === 'npmjs'
  ) {
    const metaChanges = detectMetadataChanges(storedMetadata, result.artifactMetadata);
    const depChanges = detectDeprecations(storedVersions, remoteVersionMeta);

    for (const change of [...metaChanges, ...depChanges]) {
      const normalized = normalizePollChange(
        change.eventType,
        {
          artifact: name,
          registry,
          tag: change.version,
          oldDigest: change.oldDigest,
          newDigest: change.newDigest,
          ...change.metadata,
        },
        orgId,
      );

      const [event] = await db.insert(events).values(normalized).returning();
      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

      log.info({ artifact: name, eventType: change.eventType, version: change.version }, 'Metadata change detected');
    }
  }

  // -- Fix #9: Update rcArtifacts.lastPolledAt and persist poll tracking ----

  try {
    await db
      .update(rcArtifacts)
      .set({
        lastPolledAt: new Date(),
        metadata: {
          ...storedMetadata,
          ...(result.artifactMetadata ?? {}),
          pollCount: count,
          lastFullScanAt: lastFullScanAt.get(artifactId) ?? null,
        },
      })
      .where(eq(rcArtifacts.id, artifactId));
  } catch (err) {
    log.warn({ err, artifact: name }, 'Failed to update rcArtifacts metadata');
  }
}
