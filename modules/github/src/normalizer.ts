/**
 * Normalizes raw GitHub webhook payloads into platform events.
 * This module is a pure data transformation layer — no side effects.
 *
 * Action names and event keys are aligned with GitHub’s webhook reference:
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads
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

  // Repo-wide toggle (all rules off/on). See GitHub docs: branch_protection_configuration.
  branch_protection_configuration: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.branch_protection_configuration.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
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

  repository_advisory: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    return {
      eventType: `github.repository_advisory.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        advisory: pick(p.security_advisory ?? p.advisory, [
          'ghsa_id', 'cve_id', 'summary', 'severity', 'cvss',
        ]),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  // TODO(deployment-evaluator): deployments are currently ingested purely as
  // correlation fodder (e.g. retrospective-absence rules like "S3 write must
  // be preceded by a successful prod deploy"). If we later want single-event
  // detections — non-allowlisted actor deploying to production, prod deploy
  // with state=failure, out-of-band deploys whose sha has no matching push,
  // transient_environment=false on suspicious env names — add a dedicated
  // evaluator under modules/github/src/evaluators/ and wire it into the
  // evaluator registry + templates.

  // A deployment was created. GitHub always sends action='created' for this
  // event as of the current webhook schema; we still validate rather than
  // assuming. The payload mirrors the REST shape documented at
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#deployment
  deployment: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    const deployment = p.deployment as Record<string, unknown> | undefined;
    return {
      eventType: `github.deployment.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        deployment: pick(deployment, [
          'id', 'sha', 'ref', 'task', 'environment', 'production_environment',
          'transient_environment', 'description', 'created_at', 'updated_at',
        ]),
        creator: pick(deployment?.creator, ['login', 'id']),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

  // A deployment_status webhook is sent whenever a new status is appended to a
  // deployment. The key security-relevant field is `deployment_status.state`
  // (success | failure | error | pending | in_progress | queued | inactive).
  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#deployment_status
  deployment_status: (p) => {
    const action = validateAction(p.action);
    if (!action) return null;
    const status = p.deployment_status as Record<string, unknown> | undefined;
    const deployment = p.deployment as Record<string, unknown> | undefined;
    return {
      eventType: `github.deployment_status.${action}`,
      payload: {
        resourceId: (p.repository as Record<string, unknown>)?.full_name,
        action,
        deployment_status: pick(status, [
          'id', 'state', 'environment', 'target_url', 'log_url',
          'description', 'created_at', 'updated_at',
        ]),
        // Denormalize state to the top level so correlation-rule conditions
        // can reference `state` directly (matching the idiom used in the
        // retrospective-absence example in CLAUDE context).
        state: status?.state,
        environment: status?.environment ?? deployment?.environment,
        deployment: pick(deployment, [
          'id', 'sha', 'ref', 'task', 'environment', 'production_environment',
        ]),
        creator: pick(status?.creator, ['login', 'id']),
        repository: pick(p.repository, ['full_name']),
        sender: pick(p.sender, ['login', 'id']),
      },
    };
  },

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

  // Deployment events carry the timestamp on the nested deployment object;
  // deployment_status carries it on deployment_status.
  if (eventType === 'deployment') {
    const d = payload.deployment as Record<string, unknown> | undefined;
    const ts = typeof d?.updated_at === 'string' ? d.updated_at : typeof d?.created_at === 'string' ? d.created_at : null;
    if (ts) {
      const parsed = new Date(ts);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }
  if (eventType === 'deployment_status') {
    const s = payload.deployment_status as Record<string, unknown> | undefined;
    const ts = typeof s?.updated_at === 'string' ? s.updated_at : typeof s?.created_at === 'string' ? s.created_at : null;
    if (ts) {
      const parsed = new Date(ts);
      if (!isNaN(parsed.getTime())) return parsed;
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
