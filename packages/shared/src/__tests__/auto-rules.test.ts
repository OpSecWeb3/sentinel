import { describe, it, expect, vi } from 'vitest';
import { autoCreateDetections } from '../auto-rules.js';

function fakeModule(opts: {
  templates?: Array<{ slug: string; name: string; description: string; severity: string; category: string; rules: Array<{ ruleType: string; config: Record<string, unknown>; action: string; priority?: number }> }>;
  defaultTemplates?: string[];
} = {}) {
  return {
    id: 'test-module',
    name: 'Test Module',
    templates: opts.templates ?? [],
    defaultTemplates: opts.defaultTemplates ?? [],
  } as any;
}

function fakeDb() {
  let insertedDetection = { id: 'det-1' };
  const insertCalls: any[] = [];

  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((v: unknown) => {
        insertCalls.push({ table, values: v });
        return {
          returning: vi.fn().mockResolvedValue([insertedDetection]),
        };
      }),
    })),
  };

  return {
    transaction: vi.fn(async (fn: any) => fn(tx)),
    _tx: tx,
    _insertCalls: insertCalls,
  };
}

const tables = { detections: 'detections_table', rules: 'rules_table' } as any;

describe('autoCreateDetections', () => {
  it('returns empty array when no defaultTemplates', async () => {
    const mod = fakeModule({ defaultTemplates: [] });
    const db = fakeDb();
    const result = await autoCreateDetections(mod, 'org-1', 'My Repo', db, tables);
    expect(result).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('creates detection and rules for matching template', async () => {
    const mod = fakeModule({
      templates: [{
        slug: 'visibility',
        name: 'Repo Visibility',
        description: 'Detect visibility changes',
        severity: 'high',
        category: 'access-control',
        rules: [
          { ruleType: 'github.repo_visibility', config: { visibility: 'public' }, action: 'alert', priority: 10 },
        ],
      }],
      defaultTemplates: ['visibility'],
    });

    const db = fakeDb();
    const result = await autoCreateDetections(mod, 'org-1', 'My Repo', db, tables);

    expect(result).toEqual(['det-1']);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // First insert = detection
    expect(db._insertCalls[0].values).toMatchObject({
      orgId: 'org-1',
      moduleId: 'test-module',
      name: 'Repo Visibility — My Repo',
      severity: 'high',
    });
    // Second insert = rules
    expect(db._insertCalls[1].values).toEqual([{
      detectionId: 'det-1',
      orgId: 'org-1',
      moduleId: 'test-module',
      ruleType: 'github.repo_visibility',
      config: { visibility: 'public' },
      action: 'alert',
      priority: 10,
    }]);
  });

  it('skips templates not found in module', async () => {
    const log = { warn: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
    const mod = fakeModule({ defaultTemplates: ['nonexistent'] });
    const db = fakeDb();

    const result = await autoCreateDetections(mod, 'org-1', 'res', db, tables, log);
    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'nonexistent' }),
      'Template not found in module',
    );
  });

  it('continues on transaction error and logs', async () => {
    const log = { warn: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
    const mod = fakeModule({
      templates: [
        { slug: 'a', name: 'A', description: 'd', severity: 'low', category: 'c', rules: [{ ruleType: 't', config: {}, action: 'log' }] },
        { slug: 'b', name: 'B', description: 'd', severity: 'low', category: 'c', rules: [{ ruleType: 't', config: {}, action: 'log' }] },
      ],
      defaultTemplates: ['a', 'b'],
    });

    const db = fakeDb();
    db.transaction.mockRejectedValueOnce(new Error('db down')).mockImplementation(async (fn: any) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'det-2' }]),
          })),
        })),
      };
      return fn(tx);
    });

    const result = await autoCreateDetections(mod, 'org-1', 'res', db, tables, log);
    // First template fails, second succeeds
    expect(result).toEqual(['det-2']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'a' }),
      'Failed to create detection from template',
    );
  });

  it('uses default priority 50 when template rule has no priority', async () => {
    const mod = fakeModule({
      templates: [{
        slug: 'x',
        name: 'X',
        description: 'd',
        severity: 'medium',
        category: 'c',
        rules: [{ ruleType: 't', config: {}, action: 'alert' }],
      }],
      defaultTemplates: ['x'],
    });

    const db = fakeDb();
    await autoCreateDetections(mod, 'org-1', 'res', db, tables);
    // The rules insert should use priority 50
    expect(db._insertCalls[1].values[0].priority).toBe(50);
  });
});
