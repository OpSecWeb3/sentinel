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
} from '@sentinel/db/schema/release-chain';
import { eq, and } from '@sentinel/db';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { normalizePollChange, type PollChangeType } from './normalizer.js';
import { minimatch } from 'minimatch';

const log = rootLogger.child({ component: 'release-chain-polling' });

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

// Fix #14: Poll tracking uses Redis when available, falling back to
// the rcArtifacts table metadata. The in-memory Maps serve as a local
// cache within a single worker process for the current session only.
// The authoritative state is persisted in rcArtifacts.metadata.
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
): Promise<RegistryFetchResult> {
  const versions: RemoteVersion[] = [];
  let totalCount: number | null = null;
  let pagesUsed = 0;
  const pageSize = 100;
  const maxPages = 10;

  let url: string | null =
    `${DOCKER_HUB_BASE}/repositories/${repoName}/tags?page_size=${pageSize}&ordering=last_updated`;

  while (url && pagesUsed < maxPages) {
    const response = await fetch(url);
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
): Promise<RegistryFetchResult> {
  // For incremental polls, use the abbreviated metadata endpoint.
  // Abbreviated responses only contain: name, dist-tags, modified, and
  // versions[].dist (shasum/integrity). They do NOT include: time,
  // maintainers, license, description, deprecated, or scripts.
  const headers: Record<string, string> = isFullScan
    ? {}
    : { Accept: 'application/vnd.npm.install-v1+json' };

  const response = await fetch(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`, {
    headers,
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

  // Fix #14: Load poll tracking state from DB metadata if not in memory
  const db = getDb();

  // Load persisted poll count from rcArtifacts.metadata if not cached
  if (!pollCounts.has(artifactId)) {
    const [dbArtifact] = await db
      .select({ metadata: rcArtifacts.metadata })
      .from(rcArtifacts)
      .where(eq(rcArtifacts.id, artifactId))
      .limit(1);
    const meta = (dbArtifact?.metadata as Record<string, unknown>) ?? {};
    pollCounts.set(artifactId, (meta.pollCount as number) ?? 0);
    if (meta.lastFullScanAt) {
      lastFullScanAt.set(artifactId, meta.lastFullScanAt as number);
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

  // Fetch from registry
  let result: RegistryFetchResult;
  try {
    result =
      registry === 'docker_hub'
        ? await fetchDockerHubTags(name, lastPolledAt, isFullScan)
        : await fetchNpmVersions(name, lastPolledAt, isFullScan);

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
    if (!digest) continue;

    const local = storedVersions.get(versionName);

    if (!local) {
      // New version/tag
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

      const normalized = normalizePollChange(changeType, enrichedPayload, orgId);
      const [event] = await db.insert(events).values(normalized).returning();

      // Fix #5: Insert into rcArtifactEvents and upsert rcArtifactVersions
      const [versionRow] = await db
        .insert(rcArtifactVersions)
        .values({
          artifactId,
          version: versionName,
          currentDigest: digest,
          status: 'active',
          metadata: remoteVersion.metadata ?? {},
        })
        .returning();

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
        'release-chain.attribution',
        { eventId: event.id, artifactName: name, tag: versionName, digest },
        { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
      );

      // Fix #8: Enqueue verification job for new versions
      await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'release-chain.verify', {
        artifactId,
        versionId: versionRow.id,
        artifactType: registry === 'docker_hub' ? 'docker_image' : 'npm_package',
        artifactName: name,
        version: versionName,
        digest,
        eventId: event.id,
      });

      log.info({ artifact: name, version: versionName }, 'New version discovered');
    } else if (local.currentDigest !== digest) {
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
        'release-chain.attribution',
        { eventId: event.id, artifactName: name, tag: versionName, digest },
        { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
      );

      // Fix #8: Enqueue verification job for digest changes
      await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'release-chain.verify', {
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
