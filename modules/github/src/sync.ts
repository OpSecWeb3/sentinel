/**
 * GitHub repository sync service.
 *
 * Fetches repositories accessible to a GitHub App installation, applies
 * client-provided filters, and upserts the results into github_repositories.
 * Repos that no longer appear on GitHub are marked as "removed".
 */
import { z } from 'zod';
import { minimatch } from 'minimatch';
import { getDb } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { githubInstallations, githubRepositories } from '@sentinel/db/schema/github';
import { eq, and, notInArray } from '@sentinel/db';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { generateAppJwt, getInstallationAccessToken, githubApiFetch } from './github-api.js';

const log = rootLogger.child({ component: 'github-sync' });

// ---------------------------------------------------------------------------
// Zod schema for sync options
// ---------------------------------------------------------------------------

export const syncOptionsSchema = z.object({
  visibility: z
    .array(z.enum(['public', 'private', 'internal']))
    .optional()
    .describe('Filter by visibility. Omit to include all.'),
  excludeArchived: z
    .boolean()
    .default(true)
    .describe('Exclude archived repositories.'),
  excludeForks: z
    .boolean()
    .default(false)
    .describe('Exclude forked repositories.'),
  includePatterns: z
    .array(z.string())
    .optional()
    .describe('Glob patterns — only repos matching at least one pattern are included.'),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe('Glob patterns — repos matching any pattern are excluded.'),
});

export type SyncOptions = z.infer<typeof syncOptionsSchema>;

// ---------------------------------------------------------------------------
// Sync result summary
// ---------------------------------------------------------------------------

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  totalFetched: number;
  totalAfterFilter: number;
}

// ---------------------------------------------------------------------------
// GitHub API types (subset)
// ---------------------------------------------------------------------------

interface GitHubRepo {
  id: number;
  full_name: string;
  visibility: string;
  default_branch: string;
  archived: boolean;
  fork: boolean;
}

// ---------------------------------------------------------------------------
// Paginated repo fetching
// ---------------------------------------------------------------------------

const MAX_PAGES = 500;

async function fetchAllRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let path: string | null = '/installation/repositories?per_page=100';
  let page = 0;

  while (path && page++ < MAX_PAGES) {
    const response = await githubApiFetch(path, { token });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { repositories: GitHubRepo[] };
    repos.push(...data.repositories);

    // Follow Link: <...>; rel="next"
    const link = response.headers.get('link');
    path = parseLinkNext(link);
  }

  return repos;
}

function parseLinkNext(link: string | null): string | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Filter repos
// ---------------------------------------------------------------------------

function filterRepos(repos: GitHubRepo[], opts: SyncOptions): GitHubRepo[] {
  return repos.filter((repo) => {
    // Visibility filter
    if (opts.visibility && opts.visibility.length > 0) {
      if (!opts.visibility.includes(repo.visibility as 'public' | 'private' | 'internal')) {
        return false;
      }
    }

    // Archived filter
    if (opts.excludeArchived && repo.archived) {
      return false;
    }

    // Fork filter
    if (opts.excludeForks && repo.fork) {
      return false;
    }

    // Include patterns — repo must match at least one
    if (opts.includePatterns && opts.includePatterns.length > 0) {
      const matched = opts.includePatterns.some((p) => minimatch(repo.full_name, p));
      if (!matched) return false;
    }

    // Exclude patterns — repo must not match any
    if (opts.excludePatterns && opts.excludePatterns.length > 0) {
      const excluded = opts.excludePatterns.some((p) => minimatch(repo.full_name, p));
      if (excluded) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

export async function syncRepositories(
  installationDbId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const db = getDb();

  // Load installation
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationDbId))
    .limit(1);

  if (!installation || installation.status !== 'active') {
    throw new Error(`Installation ${installationDbId} not found or not active`);
  }

  const orgId = installation.orgId;

  // Obtain token and fetch repos
  const { token } = await getInstallationAccessToken(installation.installationId);
  const allRepos = await fetchAllRepos(token);
  const filtered = filterRepos(allRepos, opts);

  const now = new Date();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  // Load existing repos for this installation
  const existingRepos = await db
    .select()
    .from(githubRepositories)
    .where(
      and(
        eq(githubRepositories.installationId, installationDbId),
        eq(githubRepositories.status, 'active'),
      ),
    );

  const existingByRepoId = new Map(existingRepos.map((r) => [r.repoId.toString(), r]));

  // Upsert each filtered repo
  const syncedRepoIds: bigint[] = [];

  for (const repo of filtered) {
    const repoId = BigInt(repo.id);
    syncedRepoIds.push(repoId);

    const existing = existingByRepoId.get(repoId.toString());

    if (!existing) {
      // New repo — insert
      await db.insert(githubRepositories).values({
        orgId,
        installationId: installationDbId,
        repoId,
        fullName: repo.full_name,
        visibility: repo.visibility,
        defaultBranch: repo.default_branch,
        archived: repo.archived,
        fork: repo.fork,
        status: 'active',
        lastSyncedAt: now,
      });
      added++;
    } else {
      // Existing repo — check for changes
      const visibilityChanged = existing.visibility !== repo.visibility;
      const changed =
        existing.fullName !== repo.full_name ||
        visibilityChanged ||
        existing.defaultBranch !== repo.default_branch ||
        existing.archived !== repo.archived ||
        existing.fork !== repo.fork ||
        existing.status !== 'active';

      if (changed) {
        await db
          .update(githubRepositories)
          .set({
            fullName: repo.full_name,
            visibility: repo.visibility,
            defaultBranch: repo.default_branch,
            archived: repo.archived,
            fork: repo.fork,
            status: 'active',
            lastSyncedAt: now,
          })
          .where(eq(githubRepositories.id, existing.id));

        // Emit event when visibility changes so the rule engine can fire alerts
        if (visibilityChanged) {
          const action = repo.visibility === 'public' ? 'publicized' : 'privatized';
          const [event] = await db.insert(events).values({
            orgId,
            moduleId: 'github',
            eventType: 'github.repository.visibility_changed',
            externalId: `sync-${installationDbId}-${repo.id}-${now.getTime()}`,
            payload: {
              resourceId: repo.full_name,
              action,
              repository: { full_name: repo.full_name, visibility: repo.visibility, id: repo.id },
              sender: { login: 'sync' },
              source: 'sync',
              previousVisibility: existing.visibility,
            },
            occurredAt: now,
          }).returning();

          const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
          await eventsQueue.add('event.evaluate', { eventId: event.id });

          log.info({ repoId: repo.id, repo: repo.full_name, from: existing.visibility, to: repo.visibility }, 'Visibility change detected during sync — event emitted');
        }

        updated++;
      } else {
        // Touch lastSyncedAt even if nothing else changed
        await db
          .update(githubRepositories)
          .set({ lastSyncedAt: now })
          .where(eq(githubRepositories.id, existing.id));
        unchanged++;
      }
    }
  }

  // Mark repos removed from GitHub (or no longer matching filters)
  let removed = 0;
  if (syncedRepoIds.length > 0) {
    const removedRows = await db
      .update(githubRepositories)
      .set({ status: 'removed' })
      .where(
        and(
          eq(githubRepositories.installationId, installationDbId),
          eq(githubRepositories.status, 'active'),
          notInArray(githubRepositories.repoId, syncedRepoIds),
        ),
      )
      .returning({ id: githubRepositories.id });
    removed = removedRows.length;
  } else {
    // No repos matched filters — mark all active repos as removed
    const removedRows = await db
      .update(githubRepositories)
      .set({ status: 'removed' })
      .where(
        and(
          eq(githubRepositories.installationId, installationDbId),
          eq(githubRepositories.status, 'active'),
        ),
      )
      .returning({ id: githubRepositories.id });
    removed = removedRows.length;
  }

  log.info({
    installationId: installationDbId,
    added, updated, removed, unchanged,
    totalFetched: allRepos.length,
    totalAfterFilter: filtered.length,
  }, 'Sync complete');

  return {
    added,
    updated,
    removed,
    unchanged,
    totalFetched: allRepos.length,
    totalAfterFilter: filtered.length,
  };
}
