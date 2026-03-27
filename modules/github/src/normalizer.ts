/**
 * Normalizes raw GitHub webhook payloads into platform events.
 * This module is a pure data transformation layer — no side effects.
 */

interface NormalizedEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

type EventHandler = (p: Record<string, unknown>) => NormalizedEventInput | null;

// Fix #5: Validate action matches safe pattern before interpolating into event types
const VALID_ACTION_RE = /^[a-z_]+$/;

function validateAction(action: unknown): string | null {
  if (typeof action !== 'string') return null;
  return VALID_ACTION_RE.test(action) ? action : null;
}

const EVENT_MAP: Record<string, EventHandler> = {
  repository: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;

    if (action === 'publicized' || action === 'privatized') {
      return {
        eventType: 'github.repository.visibility_changed',
        payload: {
          resourceId: (p.repository as Record<string, unknown>)?.full_name,
          action,
          repository: pick(p.repository, ['full_name', 'visibility', 'id']),
          sender: pick(p.sender, ['login', 'id']),
        },
      };
    }
    if (['created', 'deleted', 'archived', 'unarchived', 'transferred', 'renamed'].includes(action)) {
      return {
        eventType: `github.repository.${action}`,
        payload: {
          resourceId: (p.repository as Record<string, unknown>)?.full_name,
          action,
          repository: pick(p.repository, ['full_name', 'visibility', 'id', 'private']),
          sender: pick(p.sender, ['login', 'id']),
        },
      };
    }
    return null;
  },

  member: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.member.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        member: pick(p.member, ['login', 'id', 'role']),
        repository: p.repository ? pick(p.repository, ['full_name']) : undefined,
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  organization: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.organization.${action}`,
      payload: {
        resourceId: (p.organization as Record<string, unknown>)?.login,
        action,
        organization: pick(p.organization, ['login', 'id']),
        membership: p.membership,
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  team: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.team.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name ?? (p.organization as Record<string, unknown>)?.login,
        action,
        team: pick(p.team, ['name', 'slug', 'permission']),
        repository: p.repository ? pick(p.repository, ['full_name']) : undefined,
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  branch_protection_rule: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.branch_protection.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        rule: pick(p.rule, ['name', 'pattern']),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
        changes: p.changes,
      },
    };
  },

  deploy_key: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.deploy_key.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        key: pick(p.key, ['id', 'title', 'read_only']),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  secret_scanning_alert: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.secret_scanning.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        alert: pick(p.alert, ['number', 'secret_type', 'state']),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  push: (p) => ({
    eventType: 'github.push',
    payload: {
      resourceId: (p.repository as Record<string, unknown>)?.full_name,
      ref: p.ref,
      forced: p.forced,
      repository: pick(p.repository, ['full_name']),
      pusher: pick(p.pusher, ['name', 'email']),
      sender: pick(p.sender, ['login', 'id']),
      commits_count: Array.isArray(p.commits) ? p.commits.length : 0,
      head_commit: p.head_commit
        ? pick(p.head_commit, ['id', 'message'])
        : null,
    },
  }),

  installation: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;

    return {
      eventType: `github.installation.${action}`,
      payload: {
        resourceId: (p.installation as Record<string, unknown>)?.id,
        action,
        installation: pick(p.installation, ['id', 'app_slug', 'target_type']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },
};

// Fix #10: Extract event timestamp from payload where available
function extractEventTimestamp(eventType: string, payload: Record<string, unknown>): Date {
  // Push events: use head_commit.timestamp or repository.pushed_at
  if (eventType === 'push') {
    const headCommit = payload.head_commit as Record<string, unknown> | undefined;
    if (headCommit?.timestamp && typeof headCommit.timestamp === 'string') {
      const ts = new Date(headCommit.timestamp);
      if (!isNaN(ts.getTime())) return ts;
    }
    const repo = payload.repository as Record<string, unknown> | undefined;
    if (repo?.pushed_at && typeof repo.pushed_at === 'number') {
      return new Date((repo.pushed_at as number) * 1000);
    }
  }

  // Many events include an action timestamp at the top level
  if (typeof payload.updated_at === 'string') {
    const ts = new Date(payload.updated_at);
    if (!isNaN(ts.getTime())) return ts;
  }
  if (typeof payload.created_at === 'string') {
    const ts = new Date(payload.created_at);
    if (!isNaN(ts.getTime())) return ts;
  }

  // Fallback to server time
  return new Date();
}

export function normalizeGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  orgId: string,
) {
  const handler = EVENT_MAP[eventType];
  if (!handler) return null;

  const result = handler(payload);
  if (!result) return null;

  return {
    orgId,
    moduleId: 'github' as const,
    eventType: result.eventType,
    externalId: deliveryId,
    payload: result.payload,
    occurredAt: extractEventTimestamp(eventType, payload),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fix #12: Return {} instead of undefined when input is null/non-object
function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) result[key] = (obj as Record<string, unknown>)[key];
  }
  return result;
}
