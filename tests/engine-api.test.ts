import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SmartEngine, type EngineEvent } from '../src/engine/index.js';
import { Store } from '../src/state.js';
import { defaults } from '../src/config.js';
import type { Backend, Result } from '../src/types.js';

it('consumes typed API, denies approvals by default, preserves uncertainty and closes backends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-api-')); const project = join(root, 'project'); await mkdir(project);
  const config = structuredClone(defaults); config.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' };
  const events: EngineEvent[] = []; let closed = 0, granted = true;
  const engine = new SmartEngine(new Store(join(root, 'state')), async (_d, _p, approve) => ({
    catalog: async () => Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })),
    create: async () => 'fixture', abort: async () => false, close: () => { closed++; },
    prompt: async (): Promise<Result> => {
      granted = await approve('PRIVATE_OPERATION');
      return { text: 'tests passed', usage: [{ messageId: randomUUID(), inputTokens: 1, outputTokens: 1, source: 'local', costUsd: 0 }], validation: 'none', failure: 'permission', evidence: [] };
    },
  } satisfies Backend));
  try {
    const handle = await engine.run({ objective: 'Implement a parser', projectPath: project, config, onEvent: e => events.push(e) });
    expect((await handle.result).status).toBe('blocked'); expect(granted).toBe(false); expect(closed).toBe(1);
    expect((await engine.inspect(handle.taskId, project)).note).toBe('PERMISSION_DENIED');
    expect(events.some(e => e.type === 'approval-denied')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_OPERATION');
    await expect(engine.continue(handle.taskId, { objective: '', projectPath: project, config })).rejects.toThrow('Legacy');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('exposes cancellation without claiming an uncertain abort succeeded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-cancel-')); const project = join(root, 'project'); await mkdir(project);
  const config = structuredClone(defaults); config.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const engine = new SmartEngine(new Store(join(root, 'state')), async () => ({
    catalog: async () => Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })),
    create: async () => 'fixture', close() {}, abort: async () => { release(); return false; },
    prompt: async () => { entered(); await waiting; throw new Error('uncertain'); },
  }));
  try {
    const handle = await engine.run({ objective: 'Implement a parser', projectPath: project, config });
    await started; expect(await handle.cancel()).toBe(false);
    const task = await handle.result; expect(task.status).toBe('cancelled'); expect(task.unknownCost).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('continues confirmed portable checkpoints and retains IDs/counters without inventing legacy continuity', async () => {
  const { repositoryFixture } = await import('./factory-repository.js');
  const f = await repositoryFixture(); const config = structuredClone(defaults);
  config.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' };
  config.schemaVersion = 2; config.destinations = [{ id: 'scripted', backend: 'codex', billing: 'subscription', models: config.models }];
  let requests = 0, closed = 0;
  const engine = new SmartEngine(new Store(join(f.root, 'engine')), async () => ({
    catalog: async () => Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })),
    create: async () => 'confirmed-session', prepare: async () => {}, abort: async () => true, close: () => { closed++; },
    prompt: async () => ({ text: 'private observation', usage: [], evidence: [], validation: 'none', toolsExecuted: false, ...(requests++ === 0 ? { failure: 'infrastructure', retryable: false } : {}) }),
  }));
  try {
    const input = { objective: 'Explain the parser', projectPath: f.repo, config };
    const first = await engine.run(input), blocked = await first.result;
    expect(blocked.status).toBe('blocked'); expect(blocked.calls).toBe(1);
    const resumed = await engine.continue(first.taskId, { ...input, objective: 'ignored; portable objective remains private' });
    const final = await resumed.result; expect(final.id).toBe(first.taskId); expect(final.status).toBe('completed'); expect(final.calls).toBe(2); expect(closed).toBe(2);
  } finally { await f.cleanup(); }
});

it('returns a handle during legacy preflight so cancellation can prevent session creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-preflight-')); const project = join(root, 'project'); await mkdir(project);
  const config = structuredClone(defaults); config.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' };
  let release!: () => void, creates = 0;
  const wait = new Promise<void>(r => { release = r; });
  const engine = new SmartEngine(new Store(join(root, 'state')), async () => ({
    catalog: async () => { await wait; return Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })); },
    create: async () => { creates++; return 'never-created'; }, abort: async () => true, close() {}, prompt: async () => { throw new Error('never called'); },
  }));
  try {
    const handle = await engine.run({ objective: 'Implement parser', projectPath: project, config });
    expect(await handle.cancel()).toBe(true); release(); expect((await handle.result).status).toBe('cancelled'); expect(creates).toBe(0);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
