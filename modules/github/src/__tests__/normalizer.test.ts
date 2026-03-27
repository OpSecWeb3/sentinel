import { describe, it, expect } from 'vitest';
import { normalizeGitHubEvent } from '../normalizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-1';
const DELIVERY = 'delivery-abc';

function baseSender() {
  return { login: 'alice', id: 42 };
}

function baseRepo() {
  return { full_name: 'acme/core', visibility: 'public', id: 1, private: false };
}

// ===========================================================================
// repository events
// ===========================================================================

describe('normalizeGitHubEvent — repository', () => {
  it('normalizes publicized as visibility_changed', () => {
    const result = normalizeGitHubEvent(
      'repository',
      { action: 'publicized', repository: baseRepo(), sender: baseSender() },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.repository.visibility_changed');
    expect(result!.payload.action).toBe('publicized');
    expect(result!.moduleId).toBe('github');
    expect(result!.orgId).toBe(ORG_ID);
    expect(result!.externalId).toBe(DELIVERY);
  });

  it('normalizes privatized as visibility_changed', () => {
    const result = normalizeGitHubEvent(
      'repository',
      { action: 'privatized', repository: baseRepo(), sender: baseSender() },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.repository.visibility_changed');
    expect(result!.payload.action).toBe('privatized');
  });

  it('normalizes created as repository.created', () => {
    const result = normalizeGitHubEvent(
      'repository',
      { action: 'created', repository: baseRepo(), sender: baseSender() },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.repository.created');
  });

  it('normalizes deleted as repository.deleted', () => {
    const result = normalizeGitHubEvent(
      'repository',
      { action: 'deleted', repository: baseRepo(), sender: baseSender() },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.repository.deleted');
  });

  it('returns null for unsupported repository actions', () => {
    const result = normalizeGitHubEvent(
      'repository',
      { action: 'edited', repository: baseRepo(), sender: baseSender() },
      DELIVERY,
      ORG_ID,
    );

    expect(result).toBeNull();
  });
});

// ===========================================================================
// member events
// ===========================================================================

describe('normalizeGitHubEvent — member', () => {
  it('normalizes member added', () => {
    const result = normalizeGitHubEvent(
      'member',
      {
        action: 'added',
        member: { login: 'bob', id: 99, role: 'admin' },
        repository: baseRepo(),
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.member.added');
    expect(result!.payload.member).toEqual({ login: 'bob', id: 99, role: 'admin' });
  });

  it('handles missing repository gracefully', () => {
    const result = normalizeGitHubEvent(
      'member',
      {
        action: 'removed',
        member: { login: 'bob', id: 99 },
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.member.removed');
    expect(result!.payload.repository).toBeUndefined();
  });
});

// ===========================================================================
// organization events
// ===========================================================================

describe('normalizeGitHubEvent — organization', () => {
  it('normalizes organization member_added', () => {
    const result = normalizeGitHubEvent(
      'organization',
      {
        action: 'member_added',
        organization: { login: 'acme', id: 1 },
        membership: { user: { login: 'bob' } },
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.organization.member_added');
    expect(result!.payload.organization).toEqual({ login: 'acme', id: 1 });
  });
});

// ===========================================================================
// team events
// ===========================================================================

describe('normalizeGitHubEvent — team', () => {
  it('normalizes team created', () => {
    const result = normalizeGitHubEvent(
      'team',
      {
        action: 'created',
        team: { name: 'devops', slug: 'devops', permission: 'push' },
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.team.created');
    expect(result!.payload.team).toEqual({ name: 'devops', slug: 'devops', permission: 'push' });
  });
});

// ===========================================================================
// branch_protection_rule events
// ===========================================================================

describe('normalizeGitHubEvent — branch_protection_rule', () => {
  it('normalizes branch protection edited', () => {
    const result = normalizeGitHubEvent(
      'branch_protection_rule',
      {
        action: 'edited',
        rule: { name: 'main protection', pattern: 'main' },
        repository: baseRepo(),
        sender: baseSender(),
        changes: { enforcement_level: { from: 'everyone' } },
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.branch_protection.edited');
    expect(result!.payload.rule).toEqual({ name: 'main protection', pattern: 'main' });
  });
});

// ===========================================================================
// deploy_key events
// ===========================================================================

describe('normalizeGitHubEvent — deploy_key', () => {
  it('normalizes deploy key created', () => {
    const result = normalizeGitHubEvent(
      'deploy_key',
      {
        action: 'created',
        key: { id: 1, title: 'deploy-bot', read_only: false },
        repository: baseRepo(),
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.deploy_key.created');
    expect(result!.payload.key).toEqual({ id: 1, title: 'deploy-bot', read_only: false });
  });
});

// ===========================================================================
// secret_scanning_alert events
// ===========================================================================

describe('normalizeGitHubEvent — secret_scanning_alert', () => {
  it('normalizes secret scanning created', () => {
    const result = normalizeGitHubEvent(
      'secret_scanning_alert',
      {
        action: 'created',
        alert: { number: 7, secret_type: 'aws_access_key_id', state: 'open' },
        repository: baseRepo(),
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.secret_scanning.created');
    expect(result!.payload.alert).toEqual({ number: 7, secret_type: 'aws_access_key_id', state: 'open' });
  });
});

// ===========================================================================
// push events
// ===========================================================================

describe('normalizeGitHubEvent — push', () => {
  it('normalizes push event with commits', () => {
    const result = normalizeGitHubEvent(
      'push',
      {
        ref: 'refs/heads/main',
        forced: true,
        repository: baseRepo(),
        pusher: { name: 'alice', email: 'alice@example.com' },
        sender: baseSender(),
        commits: [{ id: 'abc' }, { id: 'def' }],
        head_commit: { id: 'def', message: 'yolo push' },
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('github.push');
    expect(result!.payload.ref).toBe('refs/heads/main');
    expect(result!.payload.forced).toBe(true);
    expect(result!.payload.commits_count).toBe(2);
    expect(result!.payload.head_commit).toEqual({ id: 'def', message: 'yolo push' });
  });

  it('handles missing commits array gracefully', () => {
    const result = normalizeGitHubEvent(
      'push',
      {
        ref: 'refs/heads/main',
        forced: false,
        repository: baseRepo(),
        pusher: { name: 'alice' },
        sender: baseSender(),
        head_commit: null,
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.payload.commits_count).toBe(0);
    expect(result!.payload.head_commit).toBeNull();
  });
});

// ===========================================================================
// Unknown event types
// ===========================================================================

describe('normalizeGitHubEvent — unknown types', () => {
  it('returns null for completely unknown event type', () => {
    const result = normalizeGitHubEvent(
      'check_run',
      { action: 'completed' },
      DELIVERY,
      ORG_ID,
    );

    expect(result).toBeNull();
  });

  it('returns null for empty event type', () => {
    const result = normalizeGitHubEvent('', {}, DELIVERY, ORG_ID);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Missing / malformed fields
// ===========================================================================

describe('normalizeGitHubEvent — missing fields', () => {
  it('handles missing sender gracefully (returns undefined fields)', () => {
    const result = normalizeGitHubEvent(
      'push',
      {
        ref: 'refs/heads/main',
        forced: false,
        repository: baseRepo(),
        pusher: { name: 'alice' },
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    // sender is picked but the source is undefined, so pick returns undefined
    expect(result!.payload.sender).toBeUndefined();
  });

  it('handles null repository in pick gracefully', () => {
    const result = normalizeGitHubEvent(
      'member',
      {
        action: 'added',
        member: { login: 'bob', id: 99 },
        repository: null,
        sender: baseSender(),
      },
      DELIVERY,
      ORG_ID,
    );

    expect(result).not.toBeNull();
    expect(result!.payload.repository).toBeUndefined();
  });
});
