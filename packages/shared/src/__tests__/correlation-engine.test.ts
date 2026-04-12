import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createHash } from 'node:crypto';
import type { NormalizedEvent } from '../rules.js';
import type {
  CorrelationRuleRow,
  CorrelationRuleConfig,
  CorrelationInstance,
  CorrelatedAlertCandidate,
} from '../correlation-types.js';

// ---------------------------------------------------------------------------
// Mock DB + Redis before importing the engine
// ---------------------------------------------------------------------------

vi.mock('@sentinel/db', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((_col: unknown) => ({ type: 'asc' })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  isNull: vi.fn((_col: unknown) => ({ type: 'isNull' })),
  lt: vi.fn((_col: unknown, _val: unknown) => ({ type: 'lt' })),
}));

vi.mock('@sentinel/db/schema/correlation', () => ({
  correlationRules: {
    orgId: 'orgId',
    status: 'status',
    name: 'name',
    id: 'id',
    lastTriggeredAt: 'lastTriggeredAt',
  },
}));

import {
  CorrelationEngine,
  type CorrelationEngineConfig,
  type CorrelationEvaluationResult,
} from '../correlation-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal Redis mock with a Map-backed store. */
function createRedisMock() {
  const store = new Map<string, string>();

  const mock = {
    _store: store,

    get: vi.fn(async (key: string) => store.get(key) ?? null),

    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      // Check for NX flag
      const flags = _args.map(String);
      if (flags.includes('NX') && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    }),

    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    }),

    /**
     * Minimal Lua eval mock that handles:
     *  - SEQ_ADVANCE_LUA (compare-and-swap on sequence instances)
     *  - AGG_INCR_LUA / AGG_SADD_LUA (aggregation counters)
     *
     * The mock identifies the script by inspecting the Lua source text.
     */
    eval: vi.fn(async (script: string, _numKeys: number, key: string, ...argv: string[]) => {
      // SEQ_ADVANCE_LUA — CAS on sequence instance
      if (script.includes('currentStepIndex')) {
        const raw = store.get(key);
        if (!raw) return -1;
        try {
          const instance = JSON.parse(raw);
          const expected = Number(argv[0]);
          if (instance.currentStepIndex !== expected) return 0;
          // CAS success — write new value
          store.set(key, argv[1]);
          return 1;
        } catch {
          return -1;
        }
      }

      // AGG_INCR_LUA
      if (script.includes('INCR')) {
        const current = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(current));
        const threshold = Number(argv[0]);
        if (current >= threshold) {
          store.delete(key);
          return [current, 1];
        }
        return [current, 0];
      }

      // AGG_SADD_LUA
      if (script.includes('SADD')) {
        const setStr = store.get(key) ?? '[]';
        const set: string[] = JSON.parse(setStr);
        if (!set.includes(argv[0])) set.push(argv[0]);
        store.set(key, JSON.stringify(set));
        const threshold = Number(argv[1]);
        if (set.length >= threshold) {
          store.delete(key);
          return [set.length, 1];
        }
        return [set.length, 0];
      }

      return null;
    }),

    zadd: vi.fn(async () => 1),
    zrem: vi.fn(async () => 1),
    pttl: vi.fn(async (key: string) => store.has(key) ? 60000 : -2),

    pipeline: vi.fn(() => {
      const cmds: Array<() => void> = [];
      const p = {
        del: vi.fn((key: string) => {
          cmds.push(() => store.delete(key));
          return p;
        }),
        exec: vi.fn(async () => {
          cmds.forEach((fn) => fn());
          return cmds.map(() => [null, 1]);
        }),
      };
      return p;
    }),
  };

  return mock;
}

function createDbMock() {
  const selectResult: unknown[] = [];
  const updateResult: unknown[] = [];

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockImplementation(() => Promise.resolve(selectResult)),
  };

  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => Promise.resolve(updateResult)),
  };

  const db = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    _selectResult: selectResult,
    _updateResult: updateResult,
    _selectChain: selectChain,
    _updateChain: updateChain,
  };

  return db;
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'github',
    eventType: 'branch_protection.disabled',
    externalId: null,
    payload: {
      repository: { full_name: 'acme/repo' },
      actor: 'alice',
      sender: { login: 'alice' },
    },
    occurredAt: new Date('2026-03-27T10:00:00Z'),
    receivedAt: new Date('2026-03-27T10:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<CorrelationRuleRow> = {}): CorrelationRuleRow {
  return {
    id: 'rule-1',
    orgId: 'org-1',
    createdBy: 'user-1',
    name: 'Disable protection then force push',
    description: null,
    severity: 'high',
    status: 'active',
    config: makeTwoStepConfig(),
    channelIds: [],
    slackChannelId: null,
    slackChannelName: null,
    cooldownMinutes: 0,
    lastTriggeredAt: null,
    ...overrides,
  };
}

function makeTwoStepConfig(overrides: Partial<CorrelationRuleConfig> = {}): CorrelationRuleConfig {
  return {
    type: 'sequence',
    correlationKey: [{ field: 'repository.full_name', alias: 'repo' }],
    windowMinutes: 60,
    steps: [
      {
        name: 'ProtectionDisabled',
        eventFilter: {
          moduleId: 'github',
          eventType: 'branch_protection.disabled',
          conditions: [],
        },
        matchConditions: [],
      },
      {
        name: 'ForcePush',
        eventFilter: {
          moduleId: 'github',
          eventType: 'push.force',
          conditions: [],
        },
        matchConditions: [],
      },
    ],
    ...overrides,
  } as CorrelationRuleConfig;
}

function makeThreeStepConfig(): CorrelationRuleConfig {
  return {
    type: 'sequence',
    correlationKey: [{ field: 'repository.full_name', alias: 'repo' }],
    windowMinutes: 120,
    steps: [
      {
        name: 'ProtectionDisabled',
        eventFilter: { moduleId: 'github', eventType: 'branch_protection.disabled', conditions: [] },
        matchConditions: [],
      },
      {
        name: 'ForcePush',
        eventFilter: { moduleId: 'github', eventType: 'push.force', conditions: [] },
        matchConditions: [],
      },
      {
        name: 'ProtectionReEnabled',
        eventFilter: { moduleId: 'github', eventType: 'branch_protection.enabled', conditions: [] },
        matchConditions: [],
      },
    ],
  } as CorrelationRuleConfig;
}

function computeKeyHash(parts: string): string {
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

let redis: ReturnType<typeof createRedisMock>;
let db: ReturnType<typeof createDbMock>;
let engine: CorrelationEngine;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  redis = createRedisMock();
  db = createDbMock();
  engine = new CorrelationEngine({ redis, db } as unknown as CorrelationEngineConfig);
  // Clear the module-level rule cache to prevent cross-test contamination.
  // The cache is shared across all engine instances in a process (by design),
  // but tests use different rule configs per test case.
  engine.invalidateCache('org-1');
  engine.invalidateCache('org-2');
});

// ===========================================================================
// Event Matching
// ===========================================================================

describe('Event Matching', () => {
  it('matches step 0 by eventType', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('matches step 0 by moduleId + conditions', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: {
              moduleId: 'github',
              eventType: 'push.force',
              conditions: [{ field: 'repository.full_name', operator: '==', value: 'acme/repo' }],
            },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'other', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ eventType: 'push.force' });
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('does NOT match any step - returns empty', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ eventType: 'member.added', moduleId: 'github' });
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.size).toBe(0);
    expect(result.advancedRuleIds.size).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('event matches step 1 but not step 0 - no new instance', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // push.force matches step 1 but not step 0
    const event = makeEvent({ eventType: 'push.force' });
    const result = await engine.evaluate(event);

    // No instance exists yet, so step 1 cannot advance and step 0 doesn't match
    expect(result.startedRuleIds.size).toBe(0);
    expect(result.advancedRuleIds.size).toBe(0);
  });

  it('eventType as array - matches if any element matches', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: {
              moduleId: 'github',
              eventType: ['branch_protection.disabled', 'branch_protection.removed'],
              conditions: [],
            },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'push.force', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ eventType: 'branch_protection.removed' });
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('conditions evaluated using evaluateConditions', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: {
              eventType: 'branch_protection.disabled',
              conditions: [{ field: 'actor', operator: '==', value: 'alice' }],
            },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'push.force', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.has('rule-1')).toBe(true);

    // Different actor fails condition
    engine.invalidateCache('org-1');
    db._selectChain.orderBy.mockResolvedValue([rule]);
    const event2 = makeEvent({ payload: { actor: 'bob', repository: { full_name: 'acme/repo' } } });
    const result2 = await engine.evaluate(event2);
    expect(result2.startedRuleIds.size).toBe(0);
  });

  it('missing moduleId in filter matches any module', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'push.force', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ moduleId: 'some-other-module' });
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('missing eventType in filter matches any event type', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: { moduleId: 'github', conditions: [] },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'push.force', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ eventType: 'literally.anything' });
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('empty conditions array always matches', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });

  it('condition on nested payload field', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        steps: [
          {
            name: 'Step0',
            eventFilter: {
              eventType: 'branch_protection.disabled',
              conditions: [{ field: 'sender.login', operator: '==', value: 'alice' }],
            },
            matchConditions: [],
          },
          {
            name: 'Step1',
            eventFilter: { eventType: 'push.force', conditions: [] },
            matchConditions: [],
          },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ payload: { sender: { login: 'alice' }, repository: { full_name: 'acme/repo' } } });
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.has('rule-1')).toBe(true);
  });
});

// ===========================================================================
// Correlation Key
// ===========================================================================

describe('Correlation Key', () => {
  it('key computed from single field', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    // Should save instance to Redis with the expected hash
    const expectedHash = computeKeyHash('repo=acme/repo');
    const seqKey = `sentinel:corr:seq:rule-1:${expectedHash}`;
    expect(redis.set).toHaveBeenCalledWith(
      seqKey,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('key computed from multiple fields', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        correlationKey: [
          { field: 'repository.full_name', alias: 'repo' },
          { field: 'actor' },
        ],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    const expectedHash = computeKeyHash('repo=acme/repo|actor=alice');
    const seqKey = `sentinel:corr:seq:rule-1:${expectedHash}`;
    expect(redis.set).toHaveBeenCalledWith(
      seqKey,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('missing key field in payload skips rule', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        correlationKey: [{ field: 'nonexistent.field', alias: 'missing' }],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.size).toBe(0);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('null key field value skips rule', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        correlationKey: [{ field: 'nullField' }],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ payload: { nullField: null, repository: { full_name: 'acme/repo' } } });
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.size).toBe(0);
  });

  it('different field values produce different hashes', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Two events with different repo names
    const event1 = makeEvent({
      id: 'evt-1',
      payload: { repository: { full_name: 'acme/repo-a' }, actor: 'alice' },
    });
    const event2 = makeEvent({
      id: 'evt-2',
      payload: { repository: { full_name: 'acme/repo-b' }, actor: 'alice' },
    });

    await engine.evaluate(event1);
    engine.invalidateCache('org-1');
    db._selectChain.orderBy.mockResolvedValue([rule]);
    await engine.evaluate(event2);

    const hashA = computeKeyHash('repo=acme/repo-a');
    const hashB = computeKeyHash('repo=acme/repo-b');
    expect(hashA).not.toBe(hashB);

    // Both should have instances saved
    expect(redis.set).toHaveBeenCalledWith(
      `sentinel:corr:seq:rule-1:${hashA}`,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
    expect(redis.set).toHaveBeenCalledWith(
      `sentinel:corr:seq:rule-1:${hashB}`,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('key with special characters in values', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({
      payload: { repository: { full_name: 'org/repo with spaces & special=chars|pipe' }, actor: 'alice' },
    });
    await engine.evaluate(event);

    const expectedHash = computeKeyHash('repo=org/repo with spaces & special=chars|pipe');
    const seqKey = `sentinel:corr:seq:rule-1:${expectedHash}`;
    expect(redis.set).toHaveBeenCalledWith(seqKey, expect.any(String), 'PX', expect.any(Number), 'NX');
  });

  it('alias defaults to field path when not specified', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({
        correlationKey: [{ field: 'repository.full_name' }],
      }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    // When no alias, uses the field path as alias
    const expectedHash = computeKeyHash('repository.full_name=acme/repo');
    expect(redis.set).toHaveBeenCalledWith(
      `sentinel:corr:seq:rule-1:${expectedHash}`,
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('empty correlationKey returns null — rule is skipped', async () => {
    // When correlationKey is empty the engine defensively returns null
    // (the schema requires min 1 key, so this is a safety check).
    const rule = makeRule({
      config: {
        ...makeTwoStepConfig(),
        correlationKey: [],
      } as unknown as CorrelationRuleConfig,
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    // Rule is skipped — no instance created
    expect(result.startedRuleIds.size).toBe(0);
    expect(result.advancedRuleIds.size).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});

// ===========================================================================
// Sequence Evaluation - New Instance
// ===========================================================================

describe('Sequence Evaluation - New Instance', () => {
  it('event matches step 0 creates new instance in Redis', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.has('rule-1')).toBe(true);
    expect(redis.set).toHaveBeenCalled();
  });

  it('instance has correct currentStepIndex=0, startedAt, expiresAt', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const event = makeEvent();
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    expect(savedJson).toBeDefined();

    const instance: CorrelationInstance = JSON.parse(savedJson!);
    expect(instance.currentStepIndex).toBe(0);
    expect(instance.startedAt).toBe(now);
    expect(instance.expiresAt).toBe(now + 60 * 60_000);
  });

  it('instance stores matched step with event details', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.matchedSteps).toHaveLength(1);
    expect(instance.matchedSteps[0].stepName).toBe('ProtectionDisabled');
    expect(instance.matchedSteps[0].eventId).toBe('evt-1');
    expect(instance.matchedSteps[0].eventType).toBe('branch_protection.disabled');
  });

  it('actor field extracted from payload.actor', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.matchedSteps[0].actor).toBe('alice');
  });

  it('actor falls back to payload.sender when actor is missing', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({
      payload: { sender: 'bob-sender', repository: { full_name: 'acme/repo' } },
    });
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.matchedSteps[0].actor).toBe('bob-sender');
  });

  it('actor extracted from sender object with login property (GitHub-style)', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({
      payload: { sender: { login: 'gh-user' }, repository: { full_name: 'acme/repo' } },
    });
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.matchedSteps[0].actor).toBe('gh-user');
  });

  it('multiple rules: event matches step 0 of two rules - two instances', async () => {
    const rule1 = makeRule({ id: 'rule-1' });
    const rule2 = makeRule({ id: 'rule-2', name: 'Another rule' });
    db._selectChain.orderBy.mockResolvedValue([rule1, rule2]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.startedRuleIds.has('rule-1')).toBe(true);
    expect(result.startedRuleIds.has('rule-2')).toBe(true);
  });

  it('duplicate step 0 event does NOT create second instance', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    // Second evaluation with same event - instance already exists
    const result2 = await engine.evaluate(event);
    expect(result2.startedRuleIds.size).toBe(0);
  });

  it('Redis TTL set to windowMinutes * 60000', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({ windowMinutes: 30 }),
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    // Check that set was called with correct TTL (30 * 60000 = 1800000).
    // Use closeTo to tolerate ≤1 ms drift from Date.now() advancing between
    // when expiresAt is computed and when the TTL is derived from it.
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('sentinel:corr:seq:rule-1:'),
      expect.any(String),
      'PX',
      expect.closeTo(1_800_000, 2),
      'NX',
    );
  });

  it('correlationKeyValues stored in instance', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.correlationKeyValues).toEqual({ repo: 'acme/repo' });
  });

  it('ruleId and orgId stored in instance', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    const savedJson = redis._store.get(`sentinel:corr:seq:rule-1:${keyHash}`);
    const instance: CorrelationInstance = JSON.parse(savedJson!);

    expect(instance.ruleId).toBe('rule-1');
    expect(instance.orgId).toBe('org-1');
  });
});

// ===========================================================================
// Sequence Evaluation - Advancing
// ===========================================================================

describe('Sequence Evaluation - Advancing', () => {
  async function seedStep0(rule?: CorrelationRuleRow) {
    const r = rule ?? makeRule();
    db._selectChain.orderBy.mockResolvedValue([r]);
    const event = makeEvent();
    await engine.evaluate(event);
    return r;
  }

  it('event matches step 1 advances instance to step 2 (advanced)', async () => {
    const rule = makeRule({ config: makeThreeStepConfig() });
    await seedStep0(rule);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);

    expect(result.advancedRuleIds.has('rule-1')).toBe(true);
  });

  it('two-step sequence: step 0 then step 1 produces COMPLETE alert candidate', async () => {
    await seedStep0();

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].correlationRuleId).toBe('rule-1');
  });

  it('three-step sequence requires all 3 steps', async () => {
    const rule = makeRule({ config: makeThreeStepConfig() });
    await seedStep0(rule);

    // Step 1 (force push)
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result2 = await engine.evaluate(event2);
    expect(result2.advancedRuleIds.has('rule-1')).toBe(true);
    expect(result2.candidates).toHaveLength(0);

    // Step 2 (protection re-enabled)
    const event3 = makeEvent({
      id: 'evt-3',
      eventType: 'branch_protection.enabled',
      occurredAt: new Date('2026-03-27T10:10:00Z'),
    });
    const result3 = await engine.evaluate(event3);
    expect(result3.candidates).toHaveLength(1);
  });

  it('withinMinutes constraint respected (event within window advances)', async () => {
    const config = makeTwoStepConfig({
      steps: [
        {
          name: 'Step0',
          eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
          matchConditions: [],
        },
        {
          name: 'Step1',
          eventFilter: { eventType: 'push.force', conditions: [] },
          withinMinutes: 10,
          matchConditions: [],
        },
      ],
    });
    const rule = makeRule({ config });
    await seedStep0(rule);

    // Event within 10 minutes
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates).toHaveLength(1);
  });

  it('withinMinutes constraint violated (event too late) - instance expired', async () => {
    const config = makeTwoStepConfig({
      steps: [
        {
          name: 'Step0',
          eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
          matchConditions: [],
        },
        {
          name: 'Step1',
          eventFilter: { eventType: 'push.force', conditions: [] },
          withinMinutes: 5,
          matchConditions: [],
        },
      ],
    });
    const rule = makeRule({ config });
    await seedStep0(rule);

    // Event arrives 15 minutes later - exceeds withinMinutes
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:15:00Z'),
    });
    const result = await engine.evaluate(event2);

    // The stale instance was deleted, so the step 1 event can't complete the sequence
    // (the event matches step 1, not step 0, so no new instance is started either)
    expect(result.candidates).toHaveLength(0);
  });

  it('cross-step matchCondition == (same actor) advances', async () => {
    const config = makeTwoStepConfig({
      steps: [
        {
          name: 'Step0',
          eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
          matchConditions: [],
        },
        {
          name: 'Step1',
          eventFilter: { eventType: 'push.force', conditions: [] },
          matchConditions: [
            { field: 'actor', operator: '==' as const, ref: 'Step0.actor' },
          ],
        },
      ],
    });
    const rule = makeRule({ config });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Step 0 - actor alice
    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event1);

    // Step 1 - same actor alice
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'alice', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates).toHaveLength(1);
  });

  it('cross-step matchCondition == (different actor) does NOT advance', async () => {
    const config = makeTwoStepConfig({
      steps: [
        {
          name: 'Step0',
          eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
          matchConditions: [],
        },
        {
          name: 'Step1',
          eventFilter: { eventType: 'push.force', conditions: [] },
          matchConditions: [
            { field: 'actor', operator: '==' as const, ref: 'Step0.actor' },
          ],
        },
      ],
    });
    const rule = makeRule({ config });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Step 0 - actor alice
    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event1);

    // Step 1 - different actor bob
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'bob', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates).toHaveLength(0);
    expect(result.advancedRuleIds.size).toBe(0);
  });

  it('cross-step matchCondition != (different actor) advances', async () => {
    const config = makeTwoStepConfig({
      steps: [
        {
          name: 'Step0',
          eventFilter: { eventType: 'branch_protection.disabled', conditions: [] },
          matchConditions: [],
        },
        {
          name: 'Step1',
          eventFilter: { eventType: 'push.force', conditions: [] },
          matchConditions: [
            { field: 'actor', operator: '!=' as const, ref: 'Step0.actor' },
          ],
        },
      ],
    });
    const rule = makeRule({ config });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'bob', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates).toHaveLength(1);
  });

  it('event matches wrong step index is ignored', async () => {
    const rule = makeRule({ config: makeThreeStepConfig() });
    await seedStep0(rule);

    // Current instance is at step 0, expecting step 1 (push.force)
    // Send step 2 event (branch_protection.enabled) - should be ignored
    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'branch_protection.enabled',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.advancedRuleIds.size).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('instance expired (overall window) is deleted, not advanced', async () => {
    const rule = makeRule({ config: makeTwoStepConfig({ windowMinutes: 1 }) });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({ occurredAt: new Date('2026-03-27T10:00:00Z') });
    const now = new Date('2026-03-27T10:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await engine.evaluate(event1);

    // 2 minutes later - past the 1 minute window
    const laterNow = now + 2 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(laterNow);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:02:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates).toHaveLength(0);
  });

  it('multiple instances for same rule, different keys are independent', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Step 0 for repo-a
    const event1a = makeEvent({
      id: 'evt-1a',
      payload: { repository: { full_name: 'acme/repo-a' }, actor: 'alice' },
    });
    await engine.evaluate(event1a);

    // Step 0 for repo-b
    const event1b = makeEvent({
      id: 'evt-1b',
      payload: { repository: { full_name: 'acme/repo-b' }, actor: 'bob' },
    });
    await engine.evaluate(event1b);

    // Complete sequence for repo-a only
    const event2a = makeEvent({
      id: 'evt-2a',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { repository: { full_name: 'acme/repo-a' }, actor: 'alice' },
    });
    const result = await engine.evaluate(event2a);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].triggerData.correlationKey).toEqual({ repo: 'acme/repo-a' });

    // repo-b instance should still be pending
    const hashB = computeKeyHash('repo=acme/repo-b');
    const instanceB = redis._store.get(`sentinel:corr:seq:rule-1:${hashB}`);
    expect(instanceB).toBeDefined();
  });

  it('completed instance is deleted from Redis', async () => {
    await seedStep0();

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    await engine.evaluate(event2);

    const keyHash = computeKeyHash('repo=acme/repo');
    expect(redis.del).toHaveBeenCalledWith(`sentinel:corr:seq:rule-1:${keyHash}`);
  });
});

// ===========================================================================
// Alert Candidates
// ===========================================================================

describe('Alert Candidates', () => {
  async function completeSequence(): Promise<CorrelatedAlertCandidate> {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' }, moduleId: 'github' } });
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'alice', repository: { full_name: 'acme/repo' }, moduleId: 'github' },
    });
    const result = await engine.evaluate(event2);
    return result.candidates[0];
  }

  it('completed sequence returns CorrelatedAlertCandidate', async () => {
    const candidate = await completeSequence();
    expect(candidate).toBeDefined();
    expect(candidate.triggerType).toBe('correlated');
  });

  it('alert has correct severity from rule', async () => {
    const candidate = await completeSequence();
    expect(candidate.severity).toBe('high');
  });

  it('alert title includes rule name', async () => {
    const candidate = await completeSequence();
    expect(candidate.title).toBe('Correlated: Disable protection then force push');
  });

  it('triggerData includes all matchedSteps', async () => {
    const candidate = await completeSequence();
    expect(candidate.triggerData.matchedSteps).toHaveLength(2);
    expect(candidate.triggerData.matchedSteps[0].stepName).toBe('ProtectionDisabled');
    expect(candidate.triggerData.matchedSteps[1].stepName).toBe('ForcePush');
  });

  it('sameActor=true when all steps by same actor', async () => {
    const candidate = await completeSequence();
    expect(candidate.triggerData.sameActor).toBe(true);
  });

  it('sameActor=false when different actors', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'bob', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].triggerData.sameActor).toBe(false);
  });

  it('actors array contains unique actors', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({ payload: { actor: 'alice', repository: { full_name: 'acme/repo' } } });
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'bob', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].triggerData.actors).toEqual(['alice', 'bob']);
  });

  it('timeSpanMinutes calculated correctly', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent({
      occurredAt: new Date('2026-03-27T10:00:00Z'),
      payload: { actor: 'alice', repository: { full_name: 'acme/repo' } },
    });
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'alice', repository: { full_name: 'acme/repo' } },
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].triggerData.timeSpanMinutes).toBe(5);
  });

  it('modules array lists involved modules from matched step fields', async () => {
    const candidate = await completeSequence();
    expect(candidate.triggerData.modules).toEqual(['github']);
  });

  it('description includes step summary and actor info', async () => {
    const candidate = await completeSequence();
    expect(candidate.description).toContain('Sequence completed:');
    expect(candidate.description).toContain('ProtectionDisabled');
    expect(candidate.description).toContain('ForcePush');
    expect(candidate.description).toContain('Actor: alice');
  });
});

// ===========================================================================
// Cooldown
// ===========================================================================

describe('Cooldown', () => {
  it('cooldown prevents rapid re-alerting for same rule', async () => {
    const rule = makeRule({ cooldownMinutes: 60 });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // First sequence completes - cooldown lock acquired
    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result1 = await engine.evaluate(event2);
    expect(result1.candidates).toHaveLength(1);

    // Second sequence within cooldown - lock already held
    const event3 = makeEvent({ id: 'evt-3', occurredAt: new Date('2026-03-27T10:10:00Z') });
    await engine.evaluate(event3);

    const event4 = makeEvent({
      id: 'evt-4',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:15:00Z'),
    });
    const result2 = await engine.evaluate(event4);
    expect(result2.candidates).toHaveLength(0);
  });

  it('cooldown key uses rule ID', async () => {
    const rule = makeRule({ cooldownMinutes: 30 });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    await engine.evaluate(event2);

    expect(redis.set).toHaveBeenCalledWith(
      'sentinel:corr:cooldown:rule-1',
      '1',
      'PX',
      30 * 60_000,
      'NX',
    );
  });

  it('cooldown=0 means no cooldown check', async () => {
    const rule = makeRule({ cooldownMinutes: 0 });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // First completion
    const event1 = makeEvent();
    await engine.evaluate(event1);
    const event2 = makeEvent({ id: 'evt-2', eventType: 'push.force', occurredAt: new Date('2026-03-27T10:05:00Z') });
    const result1 = await engine.evaluate(event2);
    expect(result1.candidates).toHaveLength(1);

    // Second completion should also produce candidate (no cooldown)
    const event3 = makeEvent({ id: 'evt-3', occurredAt: new Date('2026-03-27T10:10:00Z') });
    await engine.evaluate(event3);
    const event4 = makeEvent({ id: 'evt-4', eventType: 'push.force', occurredAt: new Date('2026-03-27T10:15:00Z') });
    const result2 = await engine.evaluate(event4);
    expect(result2.candidates).toHaveLength(1);
  });

  it('cooldown acquired via Redis SET NX PX', async () => {
    const rule = makeRule({ cooldownMinutes: 15 });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);
    const event2 = makeEvent({ id: 'evt-2', eventType: 'push.force', occurredAt: new Date('2026-03-27T10:05:00Z') });
    await engine.evaluate(event2);

    expect(redis.set).toHaveBeenCalledWith(
      'sentinel:corr:cooldown:rule-1',
      '1',
      'PX',
      15 * 60_000,
      'NX',
    );
  });

  it('different correlation keys have independent cooldowns (sequence-level)', async () => {
    // Cooldown is per rule, not per key. This tests that a second different-key
    // sequence is also blocked by the same cooldown.
    const rule = makeRule({ cooldownMinutes: 60 });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Complete sequence for repo-a
    const e1 = makeEvent({ id: 'e1', payload: { actor: 'alice', repository: { full_name: 'acme/repo-a' } } });
    await engine.evaluate(e1);
    const e2 = makeEvent({
      id: 'e2', eventType: 'push.force', occurredAt: new Date('2026-03-27T10:05:00Z'),
      payload: { actor: 'alice', repository: { full_name: 'acme/repo-a' } },
    });
    const r1 = await engine.evaluate(e2);
    expect(r1.candidates).toHaveLength(1);

    // Attempt sequence for repo-b - same rule cooldown is active
    const e3 = makeEvent({ id: 'e3', payload: { actor: 'bob', repository: { full_name: 'acme/repo-b' } } });
    await engine.evaluate(e3);
    const e4 = makeEvent({
      id: 'e4', eventType: 'push.force', occurredAt: new Date('2026-03-27T10:10:00Z'),
      payload: { actor: 'bob', repository: { full_name: 'acme/repo-b' } },
    });
    const r2 = await engine.evaluate(e4);
    expect(r2.candidates).toHaveLength(0);
  });

  it('Redis failure on cooldown falls back to DB', async () => {
    const rule = makeRule({ cooldownMinutes: 10 });
    db._selectChain.orderBy.mockResolvedValue([rule]);
    db._updateChain.returning.mockResolvedValue([{ id: 'rule-1' }]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    // Make cooldown SET fail on Redis
    const originalSet = redis.set;
    redis.set = vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (key.startsWith('sentinel:corr:cooldown:')) {
        throw new Error('Redis connection lost');
      }
      return originalSet(key, value, ...args);
    }) as any;

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);

    // Falls back to DB update, which returned a row = cooldown acquired
    expect(result.candidates).toHaveLength(1);
    expect(db.update).toHaveBeenCalled();
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe('Edge Cases', () => {
  it('config type != sequence is skipped', async () => {
    const rule = makeRule({
      config: {
        type: 'aggregation',
        correlationKey: [{ field: 'repository.full_name' }],
        windowMinutes: 60,
        aggregation: {
          eventFilter: { eventType: 'push', conditions: [] },
          threshold: 10,
        },
      } as unknown as CorrelationRuleConfig,
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.size).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('Redis error during instance load is logged, continues', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    // Make Redis get fail
    redis.get = vi.fn(async () => {
      throw new Error('Redis read error');
    }) as any;

    const event = makeEvent();
    // Should not throw — engine logs via structured logger and continues gracefully
    const result = await engine.evaluate(event);

    expect(result).toBeDefined();
  });

  it('empty correlation rules for org returns empty', async () => {
    db._selectChain.orderBy.mockResolvedValue([]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.candidates).toHaveLength(0);
    expect(result.startedRuleIds.size).toBe(0);
    expect(result.advancedRuleIds.size).toBe(0);
  });

  it('event with no payload fields - key computation returns null', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent({ payload: {} });
    const result = await engine.evaluate(event);

    // correlationKey requires repository.full_name which is missing
    expect(result.startedRuleIds.size).toBe(0);
  });

  it('DB failure to load rules returns empty result', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db._selectChain.orderBy.mockRejectedValue(new Error('DB connection lost'));

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.candidates).toHaveLength(0);
    expect(result.startedRuleIds.size).toBe(0);
    consoleSpy.mockRestore();
  });

  it('rule with no steps is skipped', async () => {
    const rule = makeRule({
      config: {
        type: 'sequence',
        correlationKey: [{ field: 'repository.full_name' }],
        windowMinutes: 60,
        steps: [],
      } as unknown as CorrelationRuleConfig,
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);
    expect(result.startedRuleIds.size).toBe(0);
  });

  it('very long windowMinutes (30 days) sets correct TTL', async () => {
    const rule = makeRule({
      config: makeTwoStepConfig({ windowMinutes: 43200 }), // 30 days
    });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('sentinel:corr:seq:'),
      expect.any(String),
      'PX',
      43200 * 60_000,
      'NX',
    );
  });

  it('rule with 5 steps requires all 5 to complete', async () => {
    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'repository.full_name', alias: 'repo' }],
      windowMinutes: 120,
      steps: [
        { name: 'S0', eventFilter: { eventType: 'step0', conditions: [] }, matchConditions: [] },
        { name: 'S1', eventFilter: { eventType: 'step1', conditions: [] }, matchConditions: [] },
        { name: 'S2', eventFilter: { eventType: 'step2', conditions: [] }, matchConditions: [] },
        { name: 'S3', eventFilter: { eventType: 'step3', conditions: [] }, matchConditions: [] },
        { name: 'S4', eventFilter: { eventType: 'step4', conditions: [] }, matchConditions: [] },
      ],
    } as CorrelationRuleConfig;

    const rule = makeRule({ config });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const base = new Date('2026-03-27T10:00:00Z');
    for (let i = 0; i < 4; i++) {
      const event = makeEvent({
        id: `evt-${i}`,
        eventType: `step${i}`,
        occurredAt: new Date(base.getTime() + i * 60_000),
      });
      const result = await engine.evaluate(event);
      if (i === 0) {
        expect(result.startedRuleIds.has('rule-1')).toBe(true);
      } else {
        expect(result.advancedRuleIds.has('rule-1')).toBe(true);
      }
      expect(result.candidates).toHaveLength(0);
    }

    // Final step completes the sequence
    const finalEvent = makeEvent({
      id: 'evt-4',
      eventType: 'step4',
      occurredAt: new Date(base.getTime() + 4 * 60_000),
    });
    const finalResult = await engine.evaluate(finalEvent);
    expect(finalResult.candidates).toHaveLength(1);
  });
});

// ===========================================================================
// Rule Caching
// ===========================================================================

describe('Rule Caching', () => {
  it('loadRules returns cached rules within TTL', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const rules1 = await engine.loadRules('org-1');
    const rules2 = await engine.loadRules('org-1');

    expect(rules1).toEqual(rules2);
    // DB should only be queried once due to cache
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache forces fresh DB query', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    await engine.loadRules('org-1');
    engine.invalidateCache('org-1');

    const rule2 = makeRule({ id: 'rule-2', name: 'Updated' });
    db._selectChain.orderBy.mockResolvedValue([rule2]);

    const rules = await engine.loadRules('org-1');
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('cache is per orgId', async () => {
    const rule1 = makeRule();
    const rule2 = makeRule({ id: 'rule-2', orgId: 'org-2' });

    db._selectChain.orderBy.mockResolvedValueOnce([rule1]);
    await engine.loadRules('org-1');

    db._selectChain.orderBy.mockResolvedValueOnce([rule2]);
    await engine.loadRules('org-2');

    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('cache expires after TTL', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await engine.loadRules('org-1');

    // Advance past cache TTL (30s)
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    await engine.loadRules('org-1');

    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// Result structure
// ===========================================================================

describe('Result Structure', () => {
  it('evaluate returns correct shape with all three sets/arrays', async () => {
    db._selectChain.orderBy.mockResolvedValue([]);
    const result = await engine.evaluate(makeEvent());

    expect(result).toHaveProperty('candidates');
    expect(result).toHaveProperty('advancedRuleIds');
    expect(result).toHaveProperty('startedRuleIds');
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.advancedRuleIds).toBeInstanceOf(Set);
    expect(result.startedRuleIds).toBeInstanceOf(Set);
  });

  it('orgId in candidate matches event orgId', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].orgId).toBe('org-1');
  });

  it('triggerData.correlationType is sequence', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].triggerData.correlationType).toBe('sequence');
  });

  it('triggerData.windowMinutes matches config', async () => {
    const rule = makeRule({ config: makeTwoStepConfig({ windowMinutes: 45 }) });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    const result = await engine.evaluate(event2);
    expect(result.candidates[0].triggerData.windowMinutes).toBe(45);
  });
});

// ===========================================================================
// Single-step sequence edge case
// ===========================================================================

describe('Single-step Sequence', () => {
  it('single-step sequence immediately produces candidate', async () => {
    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'repository.full_name', alias: 'repo' }],
      windowMinutes: 60,
      steps: [
        { name: 'OnlyStep', eventFilter: { eventType: 'branch_protection.disabled', conditions: [] }, matchConditions: [] },
      ],
    } as unknown as CorrelationRuleConfig;

    const rule = makeRule({ config });
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    const result = await engine.evaluate(event);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].triggerData.matchedSteps).toHaveLength(1);
  });
});

// ===========================================================================
// Step index key management
// ===========================================================================

describe('Step Index Key Management', () => {
  it('saveInstance also writes step index key', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event = makeEvent();
    await engine.evaluate(event);

    const keyHash = computeKeyHash('repo=acme/repo');
    // Step index key for step 0
    const idxKey = `sentinel:corr:idx:rule-1:0:${keyHash}`;
    expect(redis.set).toHaveBeenCalledWith(idxKey, '1', 'PX', expect.any(Number));
  });

  it('deleteInstance cleans up all step index keys via pipeline', async () => {
    const rule = makeRule();
    db._selectChain.orderBy.mockResolvedValue([rule]);

    const event1 = makeEvent();
    await engine.evaluate(event1);

    const event2 = makeEvent({
      id: 'evt-2',
      eventType: 'push.force',
      occurredAt: new Date('2026-03-27T10:05:00Z'),
    });
    await engine.evaluate(event2);

    // pipeline().del() should be called for index cleanup
    expect(redis.pipeline).toHaveBeenCalled();
  });
});
