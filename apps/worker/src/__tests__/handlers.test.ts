/**
 * Unit tests for worker handlers.
 * All external dependencies (DB, queues, logger, engines) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — variables used inside vi.mock factories must be declared here
// so they exist when vitest hoists the mock calls above the imports.
// ---------------------------------------------------------------------------

const {
  mockDb,
  mockQueueAdd,
  mockChildLogger,
  mockRuleEngineEvaluate,
  mockCorrelationEngineEvaluate,
} = vi.hoisted(() => {
  // Default thenable result when a chain is awaited without a terminal like limit().
  // Drizzle query builders are thenable — `await db.select().from().where()` returns rows.
  let _thenableResult: unknown[] = [];

  const _mockDb: Record<string, any> = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    onConflictDoNothing: vi.fn(),
    returning: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    execute: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    // Make mockDb thenable so `await db.select().from().where()` works
    then: vi.fn((resolve: any) => resolve(_thenableResult)),
  };

  // Wire up default chain behaviour (each method returns the same object)
  for (const key of Object.keys(_mockDb)) {
    if (!['limit', 'returning', 'execute', 'transaction', 'then'].includes(key)) {
      _mockDb[key].mockReturnValue(_mockDb);
    }
  }
  _mockDb.limit.mockResolvedValue([]);
  _mockDb.returning.mockResolvedValue([]);
  _mockDb.execute.mockResolvedValue({ rowCount: 0 });
  _mockDb.transaction.mockImplementation(async (cb: any) => cb(_mockDb));

  // Note: _thenableResult provides the default for `await db.select().from().where()`.
  // Use `mockDb.then.mockImplementationOnce(...)` to override per-invocation.

  return {
    mockDb: _mockDb,
    mockQueueAdd: vi.fn().mockResolvedValue({ id: 'queued-1' }),
    mockChildLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    },
    mockRuleEngineEvaluate: vi.fn().mockResolvedValue({
      candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set(),
    }),
    mockCorrelationEngineEvaluate: vi.fn().mockResolvedValue({
      candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set(),
    }),
  };
});

// ---------------------------------------------------------------------------
// vi.mock — factories reference the hoisted variables above.
// ---------------------------------------------------------------------------

vi.mock('@sentinel/db', () => ({
  getDb: vi.fn(() => mockDb),
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(vi.fn(), {
    identifier: vi.fn(),
    raw: vi.fn(),
    join: vi.fn((fragments: unknown[], _sep: unknown) => fragments),
  }),
  count: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@sentinel/db/schema/core', () => ({
  events: { id: 'events.id', orgId: 'events.orgId', moduleId: 'events.moduleId', eventType: 'events.eventType', externalId: 'events.externalId', payload: 'events.payload', occurredAt: 'events.occurredAt', receivedAt: 'events.receivedAt' },
  alerts: { id: 'alerts.id', orgId: 'alerts.orgId', eventId: 'alerts.eventId', triggerType: 'alerts.triggerType', triggerData: 'alerts.triggerData' },
  detections: { id: 'detections.id', lastTriggeredAt: 'detections.lastTriggeredAt' },
  notificationChannels: { id: 'nc.id', type: 'nc.type', config: 'nc.config', enabled: 'nc.enabled', deletedAt: 'nc.deletedAt' },
  slackInstallations: { orgId: 'si.orgId', botToken: 'si.botToken' },
  notificationDeliveries: { alertId: 'nd.alertId', channelId: 'nd.channelId', status: 'nd.status' },
}));

vi.mock('@sentinel/db/schema/correlation', () => ({
  correlationRules: { id: 'cr.id', orgId: 'cr.orgId', status: 'cr.status', lastTriggeredAt: 'cr.lastTriggeredAt' },
}));

vi.mock('@sentinel/shared/queue', () => ({
  getQueue: vi.fn(() => ({ add: mockQueueAdd })),
  QUEUE_NAMES: { EVENTS: 'events', ALERTS: 'alerts', DEFERRED: 'deferred', MODULE_JOBS: 'module-jobs' },
}));

vi.mock('@sentinel/shared/logger', () => ({
  logger: {
    child: vi.fn(() => mockChildLogger),
  },
}));

vi.mock('@sentinel/shared/rule-engine', () => ({
  RuleEngine: vi.fn().mockImplementation(() => ({
    evaluate: mockRuleEngineEvaluate,
  })),
}));

vi.mock('@sentinel/shared/correlation-engine', () => ({
  CorrelationEngine: vi.fn().mockImplementation(() => ({
    evaluate: mockCorrelationEngineEvaluate,
  })),
}));

vi.mock('@sentinel/notifications/dispatcher', () => ({
  dispatchAlert: vi.fn().mockResolvedValue([]),
}));

vi.mock('@sentinel/shared/crypto', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}));

// ---------------------------------------------------------------------------
// Imports — must come after vi.mock calls (vitest hoists vi.mock anyway).
// ---------------------------------------------------------------------------

import { dataRetentionHandler, DEFAULT_RETENTION_POLICIES } from '../handlers/data-retention.js';
import { createEventProcessingHandler } from '../handlers/event-processing.js';
import { alertDispatchHandler } from '../handlers/alert-dispatch.js';
import { createCorrelationHandler } from '../handlers/correlation-evaluate.js';
import { UnrecoverableError } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJob(data: unknown): any {
  return { data, id: 'job-1', name: 'test', attemptsMade: 0 };
}

/** Reset the chainable mock so each test starts fresh. */
function resetDbMock() {
  for (const key of Object.keys(mockDb)) {
    if (key.startsWith('_')) continue; // skip helpers
    const fn = mockDb[key];
    if (typeof fn === 'function' && 'mockReset' in fn) {
      // mockReset clears BOTH call history and queued mockImplementationOnce
      // values — otherwise leftover Once queues from a failing test leak into
      // the next test and cause mysterious wrong-return-value failures.
      fn.mockReset();
    }
  }
  // Restore default chain behaviour — most methods return mockDb for chaining
  for (const key of ['select', 'from', 'where', 'insert', 'values', 'onConflictDoNothing', 'update', 'set', 'delete']) {
    mockDb[key].mockReturnValue(mockDb);
  }
  mockDb.limit.mockResolvedValue([]);
  mockDb.returning.mockResolvedValue([]);
  mockDb.execute.mockResolvedValue({ rowCount: 0 });
  mockDb.transaction.mockImplementation(async (cb: any) => cb(mockDb));
  mockDb.then.mockImplementation((resolve: any) => resolve([]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('data-retention handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    mockQueueAdd.mockResolvedValue({ id: 'queued-1' });
  });

  it('exposes correct jobName and queueName', () => {
    expect(dataRetentionHandler.jobName).toBe('platform.data.retention');
    expect(dataRetentionHandler.queueName).toBe('deferred');
  });

  it('rejects unrecognised table names', async () => {
    const job = mockJob({
      policies: [{ table: 'users; DROP TABLE events;--', timestampColumn: 'created_at', retentionDays: 30 }],
    });

    await dataRetentionHandler.process(job);

    // The handler should skip the policy and never call execute
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'users; DROP TABLE events;--' }),
      expect.stringContaining('unrecognised table name'),
    );
  });

  it('rejects unrecognised timestamp columns', async () => {
    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'hacked_col', retentionDays: 30 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timestampColumn: 'hacked_col' }),
      expect.stringContaining('unrecognised timestamp column'),
    );
  });

  it('rejects retentionDays < 1', async () => {
    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 0 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 0 }),
      expect.stringContaining('invalid retentionDays'),
    );
  });

  it('rejects negative retentionDays', async () => {
    const job = mockJob({
      policies: [{ table: 'alerts', timestampColumn: 'created_at', retentionDays: -5 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('rejects non-integer retentionDays', async () => {
    const job = mockJob({
      policies: [{ table: 'alerts', timestampColumn: 'created_at', retentionDays: 1.5 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('rejects unrecognised filter expressions', async () => {
    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 30, filter: "1=1; DROP TABLE events;--" }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filter: "1=1; DROP TABLE events;--" }),
      expect.stringContaining('unrecognised filter expression'),
    );
  });

  it('accepts a valid allowed filter', async () => {
    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 30, filter: "module_id = 'aws'" }],
    });

    await dataRetentionHandler.process(job);

    // Should have called execute at least once (the batch loop)
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('executes DELETE for a valid policy', async () => {
    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 90 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('uses DEFAULT_RETENTION_POLICIES when job.data is empty', async () => {
    const job = mockJob({});

    await dataRetentionHandler.process(job);

    // Should execute once per default policy (each returns rowCount=0 so no batch loop)
    expect(mockDb.execute).toHaveBeenCalledTimes(DEFAULT_RETENTION_POLICIES.length);
  });

  it('uses DEFAULT_RETENTION_POLICIES when job.data.policies is undefined', async () => {
    const job = mockJob({ policies: undefined });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalledTimes(DEFAULT_RETENTION_POLICIES.length);
  });

  it('loops batch deletes when rowCount >= 1000', async () => {
    // First call returns 1000 (triggers another batch), second returns 0 (stops)
    mockDb.execute
      .mockResolvedValueOnce({ rowCount: 1000 })
      .mockResolvedValueOnce({ rowCount: 500 });

    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 90 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(mockChildLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'events', deleted: 1500 }),
      expect.stringContaining('Retention cleanup complete'),
    );
  });

  it('does not log when nothing was deleted', async () => {
    mockDb.execute.mockResolvedValue({ rowCount: 0 });

    const job = mockJob({
      policies: [{ table: 'events', timestampColumn: 'received_at', retentionDays: 90 }],
    });

    await dataRetentionHandler.process(job);

    expect(mockChildLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: 'events' }),
      expect.stringContaining('Retention cleanup complete'),
    );
  });

  it('DEFAULT_RETENTION_POLICIES contains only allowed tables and columns', () => {
    for (const policy of DEFAULT_RETENTION_POLICIES) {
      expect(policy.retentionDays).toBeGreaterThanOrEqual(1);
      // These tables and columns must be in the allow lists
      expect(['events', 'alerts', 'notification_deliveries']).toContain(policy.table);
      expect(['received_at', 'created_at']).toContain(policy.timestampColumn);
    }
  });

  // ── preserveIf / dryRun ──────────────────────────────────────────────

  it('executes DELETE with preserveIf referenced_by (allowlisted)', async () => {
    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        filter: "module_id = 'aws'",
        preserveIf: [{ kind: 'referenced_by', table: 'alerts', column: 'event_id' }],
      }],
    });

    await dataRetentionHandler.process(job);

    // Should still issue the DELETE — the preserve clause is ANDed into the WHERE
    expect(mockDb.execute).toHaveBeenCalled();
    // No warning about skipping
    expect(mockChildLogger.warn).not.toHaveBeenCalled();
  });

  it('skips referenced_by preserve rule that is not in the allowlist', async () => {
    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        preserveIf: [{ kind: 'referenced_by', table: 'users', column: 'id' }],
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ referencedBy: 'users.id' }),
      expect.stringContaining('referenced_by preserve rule not in allowlist'),
    );
    // Policy still runs — just without the skipped clause
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('skips unknown preserveIf kind with a warning', async () => {
    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        preserveIf: [{ kind: 'made_up_rule' } as unknown as import('../handlers/data-retention.js').RetentionPolicy['preserveIf'] extends (infer U)[] | undefined ? U : never],
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rule: expect.objectContaining({ kind: 'made_up_rule' }) }),
      expect.stringContaining('unknown preserveIf rule kind'),
    );
  });

  it('queries correlation window when within_correlation_window is present', async () => {
    // First execute call is the SELECT MAX(...), second is the DELETE
    mockDb.execute
      .mockResolvedValueOnce([{ maxWindowMinutes: 30 }])
      .mockResolvedValueOnce({ rowCount: 0 });

    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        preserveIf: [{ kind: 'within_correlation_window' }],
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it('skips within_correlation_window clause when no active correlation rules', async () => {
    // MAX returns 0 → no preservation clause emitted → just the DELETE
    mockDb.execute
      .mockResolvedValueOnce([{ maxWindowMinutes: 0 }])
      .mockResolvedValueOnce({ rowCount: 0 });

    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        preserveIf: [{ kind: 'within_correlation_window' }],
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it('dryRun issues SELECT COUNT and does not DELETE', async () => {
    mockDb.execute.mockResolvedValueOnce([{ c: 42 }]);

    const job = mockJob({
      policies: [{
        table: 'events',
        timestampColumn: 'received_at',
        retentionDays: 1,
        filter: "module_id = 'aws'",
        dryRun: true,
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).toHaveBeenCalledTimes(1); // just the SELECT, no DELETE
    expect(mockChildLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'events', wouldDelete: 42, dryRun: true }),
      expect.stringContaining('dry-run'),
    );
  });

  it('rejects preserveIf combined with useCtid', async () => {
    const job = mockJob({
      policies: [{
        table: 'chain_rpc_usage_hourly',
        timestampColumn: 'bucket',
        retentionDays: 1,
        useCtid: true,
        preserveIf: [{ kind: 'referenced_by', table: 'alerts', column: 'event_id' }],
      }],
    });

    await dataRetentionHandler.process(job);

    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'chain_rpc_usage_hourly' }),
      expect.stringContaining('preserveIf is not supported with useCtid'),
    );
  });
});

// ---------------------------------------------------------------------------

describe('event-processing handler', () => {
  const mockRedis = {} as any;
  const mockEvaluators = new Map();

  let handler: ReturnType<typeof createEventProcessingHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    mockQueueAdd.mockResolvedValue({ id: 'queued-1' });
    mockRuleEngineEvaluate.mockResolvedValue({ candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set() });
    handler = createEventProcessingHandler(mockEvaluators, mockRedis);
  });

  it('returns a handler with correct jobName and queueName', () => {
    expect(handler.jobName).toBe('event.evaluate');
    expect(handler.queueName).toBe('events');
  });

  it('throws UnrecoverableError on missing eventId', async () => {
    const job = mockJob({});

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError on invalid eventId (not a UUID)', async () => {
    const job = mockJob({ eventId: 'not-a-uuid' });

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError when payload is null', async () => {
    const job = mockJob(null);

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('returns early when event is not found in DB', async () => {
    mockDb.limit.mockResolvedValueOnce([]); // no event found

    const job = mockJob({ eventId: '550e8400-e29b-41d4-a716-446655440000' });

    // Should not throw, just return
    await expect(handler.process(job)).resolves.toBeUndefined();

    // Should not have called the rule engine
    expect(mockRuleEngineEvaluate).not.toHaveBeenCalled();
  });

  it('evaluates rules when event is found', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: { repo: 'test' },
      occurredAt: new Date(),
      receivedAt: new Date(),
    };

    // limit() call: event lookup
    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    // Correlation count query ends at where() — uses thenable path
    mockDb.then.mockImplementationOnce((resolve: any) => resolve([{ activeRuleCount: 0 }]));

    const job = mockJob({ eventId: fakeEvent.id });

    await handler.process(job);

    expect(mockRuleEngineEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: fakeEvent.id,
        orgId: fakeEvent.orgId,
        moduleId: fakeEvent.moduleId,
        eventType: fakeEvent.eventType,
      }),
    );
  });

  it('creates alerts and enqueues dispatch for matching candidates', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };
    const fakeAlert = { id: BigInt(42), detectionId: 'det-1' };

    // Event lookup
    mockDb.limit.mockResolvedValueOnce([fakeEvent]);

    // Rule engine returns one candidate
    mockRuleEngineEvaluate.mockResolvedValueOnce({
      candidates: [{
        orgId: 'org-1',
        detectionId: 'det-1',
        ruleId: 'rule-1',
        eventId: fakeEvent.id,
        severity: 'high',
        title: 'Test Alert',
        description: 'desc',
        triggerType: 'rule',
        triggerData: {},
      }],
      advancedRuleIds: new Set(),
      startedRuleIds: new Set(),
    });

    // Correlation count query ends at where() — uses thenable path
    mockDb.then.mockImplementationOnce((resolve: any) => resolve([{ activeRuleCount: 0 }]));

    // Transaction: insert alert returning
    mockDb.returning.mockResolvedValueOnce([fakeAlert]);

    const job = mockJob({ eventId: fakeEvent.id });

    await handler.process(job);

    // Alert insert was attempted
    expect(mockDb.insert).toHaveBeenCalled();

    // Dispatch was enqueued
    expect(mockQueueAdd).toHaveBeenCalledWith('alert.dispatch', { alertId: '42' });
  });

  it('enqueues correlation.evaluate when org has active correlation rules', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };

    // Event lookup
    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    // Active correlation rules count > 0 — thenable path
    mockDb.then.mockImplementationOnce((resolve: any) => resolve([{ activeRuleCount: 2 }]));

    mockRuleEngineEvaluate.mockResolvedValueOnce({ candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set() });

    const job = mockJob({ eventId: fakeEvent.id });
    await handler.process(job);

    // Should enqueue correlation.evaluate
    expect(mockQueueAdd).toHaveBeenCalledWith('correlation.evaluate', { eventId: fakeEvent.id });
  });

  it('does not enqueue correlation.evaluate when org has no active correlation rules', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };

    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    // Correlation count — thenable path
    mockDb.then.mockImplementationOnce((resolve: any) => resolve([{ activeRuleCount: 0 }]));

    mockRuleEngineEvaluate.mockResolvedValueOnce({ candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set() });

    const job = mockJob({ eventId: fakeEvent.id });
    await handler.process(job);

    expect(mockQueueAdd).not.toHaveBeenCalledWith('correlation.evaluate', expect.anything());
  });

  it('throws when alert dispatch enqueue fails so BullMQ retries', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };
    const fakeAlert = { id: BigInt(42), detectionId: 'det-1' };

    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    mockRuleEngineEvaluate.mockResolvedValueOnce({
      candidates: [{
        orgId: 'org-1',
        detectionId: 'det-1',
        ruleId: 'rule-1',
        eventId: fakeEvent.id,
        severity: 'high',
        title: 'Test Alert',
        description: 'desc',
        triggerType: 'rule',
        triggerData: {},
      }],
      advancedRuleIds: new Set(),
      startedRuleIds: new Set(),
    });

    // Correlation count — no active rules
    mockDb.then.mockImplementationOnce((resolve: any) => resolve([{ activeRuleCount: 0 }]));
    // Transaction: insert alert returning
    mockDb.returning.mockResolvedValueOnce([fakeAlert]);

    // Make dispatch enqueue fail
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection lost'));

    const job = mockJob({ eventId: fakeEvent.id });

    await expect(handler.process(job)).rejects.toThrow('Failed to enqueue dispatch');
  });
});

// ---------------------------------------------------------------------------

describe('alert-dispatch handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    mockQueueAdd.mockResolvedValue({ id: 'queued-1' });
  });

  it('exposes correct jobName and queueName', () => {
    expect(alertDispatchHandler.jobName).toBe('alert.dispatch');
    expect(alertDispatchHandler.queueName).toBe('alerts');
  });

  it('throws UnrecoverableError on invalid payload (missing alertId)', async () => {
    const job = mockJob({});

    await expect(alertDispatchHandler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError on non-numeric alertId', async () => {
    const job = mockJob({ alertId: 'not-a-number' });

    await expect(alertDispatchHandler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError when payload is null', async () => {
    const job = mockJob(null);

    await expect(alertDispatchHandler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('returns early when alert is not found in DB', async () => {
    mockDb.limit.mockResolvedValueOnce([]); // alert not found

    const job = mockJob({ alertId: '123' });

    await expect(alertDispatchHandler.process(job)).resolves.toBeUndefined();

    // Should not attempt to load detection or dispatch
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('loads detection when alert has a detectionId', async () => {
    const fakeAlert = {
      id: BigInt(123),
      orgId: 'org-1',
      detectionId: 'det-1',
      severity: 'high',
      title: 'Test',
      description: 'desc',
      triggerType: 'rule',
      triggerData: { moduleId: 'github' },
      createdAt: new Date(),
    };

    // First limit: alert lookup
    mockDb.limit.mockResolvedValueOnce([fakeAlert]);
    // Second limit: detection lookup
    mockDb.limit.mockResolvedValueOnce([{ id: 'det-1', channelIds: [], slackChannelId: null }]);

    const job = mockJob({ alertId: '123' });

    // Will proceed to dispatch (dispatchAlert is mocked to return [])
    await alertDispatchHandler.process(job);

    // DB was queried at least twice (alert + detection)
    expect(mockDb.from).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('correlation-evaluate handler', () => {
  const mockRedis = {} as any;
  let handler: ReturnType<typeof createCorrelationHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMock();
    mockQueueAdd.mockResolvedValue({ id: 'queued-1' });
    mockCorrelationEngineEvaluate.mockResolvedValue({ candidates: [], advancedRuleIds: new Set(), startedRuleIds: new Set() });
    handler = createCorrelationHandler(mockRedis);
  });

  it('returns a handler with correct jobName and queueName', () => {
    expect(handler.jobName).toBe('correlation.evaluate');
    expect(handler.queueName).toBe('events');
  });

  it('throws UnrecoverableError on missing eventId', async () => {
    const job = mockJob({});

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError on invalid eventId (not a UUID)', async () => {
    const job = mockJob({ eventId: 'bad-id' });

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('throws UnrecoverableError when payload is null', async () => {
    const job = mockJob(null);

    await expect(handler.process(job)).rejects.toThrow(UnrecoverableError);
  });

  it('returns early when event is not found in DB', async () => {
    mockDb.limit.mockResolvedValueOnce([]); // no event

    const job = mockJob({ eventId: '550e8400-e29b-41d4-a716-446655440000' });

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(mockCorrelationEngineEvaluate).not.toHaveBeenCalled();
  });

  it('evaluates correlation rules when event is found', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: { repo: 'test' },
      occurredAt: new Date(),
      receivedAt: new Date(),
    };

    mockDb.limit.mockResolvedValueOnce([fakeEvent]);

    const job = mockJob({ eventId: fakeEvent.id });
    await handler.process(job);

    expect(mockCorrelationEngineEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: fakeEvent.id,
        orgId: fakeEvent.orgId,
      }),
    );
  });

  it('creates correlated alerts and enqueues dispatch for candidates', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };
    const fakeAlert = { id: BigInt(99) };

    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    mockCorrelationEngineEvaluate.mockResolvedValueOnce({
      candidates: [{
        orgId: 'org-1',
        correlationRuleId: 'cr-1',
        severity: 'critical',
        title: 'Correlated Alert',
        description: 'multi-signal',
        triggerType: 'correlated',
        triggerData: { correlationType: 'threshold' },
      }],
      advancedRuleIds: new Set(['cr-1']),
      startedRuleIds: new Set(),
    });

    // insert -> values -> onConflictDoNothing -> returning
    mockDb.returning.mockResolvedValueOnce([fakeAlert]);

    const job = mockJob({ eventId: fakeEvent.id });
    await handler.process(job);

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith('alert.dispatch', { alertId: '99' });
  });

  it('re-enqueues dispatch when duplicate alert is suppressed by constraint', async () => {
    const fakeEvent = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      orgId: 'org-1',
      moduleId: 'github',
      eventType: 'push',
      externalId: 'ext-1',
      payload: {},
      occurredAt: new Date(),
      receivedAt: new Date(),
    };

    mockDb.limit.mockResolvedValueOnce([fakeEvent]);
    mockCorrelationEngineEvaluate.mockResolvedValueOnce({
      candidates: [{
        orgId: 'org-1',
        correlationRuleId: 'cr-1',
        severity: 'critical',
        title: 'Dup Alert',
        description: 'multi-signal',
        triggerType: 'correlated',
        triggerData: { correlationType: 'threshold' },
      }],
      advancedRuleIds: new Set(),
      startedRuleIds: new Set(),
    });

    // onConflictDoNothing -> returning yields empty (duplicate suppressed)
    mockDb.returning.mockResolvedValueOnce([]);
    // Lookup of existing alert
    mockDb.limit.mockResolvedValueOnce([{ id: BigInt(77) }]);

    const job = mockJob({ eventId: fakeEvent.id });
    await handler.process(job);

    // Should still enqueue dispatch for the existing alert
    expect(mockQueueAdd).toHaveBeenCalledWith('alert.dispatch', { alertId: '77' });
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: '77' }),
      expect.stringContaining('already exists'),
    );
  });
});
