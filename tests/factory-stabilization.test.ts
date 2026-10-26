import { it, expect, vi } from 'vitest';
import { writeFile, mkdir, rename, symlink, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-helpers.js';
import { contentHash, qualityGate } from '../src/factory/quality-gate.js';
import { classify } from '../src/router.js';
import { git, preflight } from '../src/factory/workspace.js';
import { FactoryStore } from '../src/factory/state.js';
import { Factory } from '../src/factory/orchestrator.js';
import { DeliveryManager } from '../src/factory/delivery.js';
vi.setConfig({ testTimeout: 20000 });
it('classifies only the objective and keeps Factory constraints in model context', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec);
    const engine = await f.factory.engine.inspect(task.engineId!, task.workspace!.path);
    expect(engine.classification).toEqual(classify(f.spec.objective));
    expect(engine.classification.sensitive).toBe(false);
    expect(engine.stages.map(s => s.kind)).not.toContain('review');
  } finally { await f.cleanup(); }
});
it('hashes file boundaries unambiguously even with binary content', async () => {
  const f = await fixture();
  try {
    const separator = '\0b.txt\0' + '0' + '\0';
    await writeFile(join(f.repo, 'a.txt'), 'X'); await writeFile(join(f.repo, 'b.txt'), 'Y' + separator + 'Z');
    const before = await contentHash(f.repo);
    await writeFile(join(f.repo, 'a.txt'), 'X' + separator + 'Y'); await writeFile(join(f.repo, 'b.txt'), 'Z');
    expect(await contentHash(f.repo)).not.toBe(before);
  } finally { await f.cleanup(); }
});
it('rejects a worktree root replaced by a symlink before validation or delivery', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec), moved = task.workspace!.path + '-moved';
    await rename(task.workspace!.path, moved); await symlink(moved, task.workspace!.path);
    await expect(qualityGate(task)).rejects.toThrow('SYMLINK');
    let approvals = 0;
    await new DeliveryManager(f.store, async () => { approvals++; return true; }).deliver(task.id);
    expect(approvals).toBe(0);
  } finally { await f.cleanup(); }
});
it('refuses state inside another checkout of the same Git repository', async () => {
  const f = await fixture();
  try {
    const linked = join(f.root, 'linked'); await git(f.repo, ['worktree', 'add', '-b', 'linked', linked, 'main']);
    const state = join(f.repo, 'unsafe-state'); await mkdir(state, { mode: 0o700 });
    await expect(preflight(linked, 'main', state, 'new-task')).rejects.toThrow('PRIVATE_STATE');
  } finally { await f.cleanup(); }
});
it('cancels pending inference consent instead of reporting a permission denial', async () => {
  const f = await fixture(); let requested!: () => void;
  const entered = new Promise<void>(r => { requested = r; });
  const factory = new Factory(f.store, f.factory.engine, f.config, async () => { requested(); return new Promise<boolean>(() => {}); });
  try {
    const running = factory.run(f.spec); await entered; await factory.cancel(f.spec.id);
    const task = await running;
    expect(task.state).toBe('CANCELLED'); expect(task.engineId).toBeUndefined(); expect(task.operation).toBeUndefined();
  } finally { await f.cleanup(); }
});
it('does not mutate a cancelled task when delivery is requested', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec); await f.factory.cancel(task.id);
    await expect(new DeliveryManager(f.store).deliver(task.id)).rejects.toThrow('checkpoint');
    expect((await f.store.get(task.id)).state).toBe('CANCELLED');
  } finally { await f.cleanup(); }
});
it('rejects symlinked private directories before creating children through them', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'target'); await mkdir(target);
    const link = join(f.root, 'link'); await symlink(target, link);
    await expect(new FactoryStore(join(link, 'child')).init()).rejects.toThrow('SYMLINK');
    expect(await readdir(target)).toEqual([]);
  } finally { await f.cleanup(); }
});
it('blocks uncertain portable checkpoints before starting a continuation operation', async () => {
  const f = await fixture('uncertain-checkpoint', 'uncertain');
  try {
    const task = await f.factory.run(f.spec);
    const engineTask: any = await f.factory.engine.inspect(task.engineId!, task.workspace!.path);
    engineTask.schemaVersion = 2; engineTask.requestState = 'uncertain'; engineTask.transitions = [];
    const { Store } = await import('../src/state.js'); await new Store(join(f.store.root, 'engine')).save(engineTask);
    await expect(f.factory.continue(task.id)).rejects.toThrow('INSPECTION_REQUIRED');
    expect((await f.store.get(task.id)).operation).toBeUndefined();
    const release = await f.store.lock('next-task'); await release();
  } finally { await f.cleanup(); }
});
it('binds inference consent to an immutable snapshot of the execution limits', async () => {
  const f = await fixture(); f.config.limits.maxModelCalls = 0;
  const factory = new Factory(f.store, f.factory.engine, f.config, async d => { if (d.startsWith('Authorize ONE')) f.config.limits.maxModelCalls = 100; return true; });
  try {
    const task = await factory.run(f.spec);
    expect(task.state).toBe('BLOCKED'); expect(task.engineSummary?.calls).toBe(0); expect(f.requests()).toBe(0);
    await expect(factory.continue(task.id)).rejects.toThrow('CONFIG_CHANGED');
  } finally { await f.cleanup(); }
});

it('inspects a crashed operation without rewriting its durable owner or journal', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec); task.pid = 2147483647; task.state = 'DELIVERING'; task.operation = { id: 'uncertain-push', kind: 'push' }; await f.store.save(task);
    const path = join(f.store.root, task.id + '.json'), before = await readFile(path, 'utf8');
    expect((await f.factory.inspect(task.id)).state).toBe('BLOCKED');
    expect(await readFile(path, 'utf8')).toBe(before);
  } finally { await f.cleanup(); }
});
it('shares project locks between Smart writers, private Engine metadata and delivery', async () => {
  const f = await fixture();
  const { Store, lockProject, stateRoot } = await import('../src/state.js');
  const { SmartEngine } = await import('../src/engine/index.js');
  const { canonicalHostPath } = await import('../src/factory/workspace.js');
  try {
    expect(new FactoryStore().projectLockRoot).toBe(canonicalHostPath(stateRoot()));
    const locks = join(f.root, 'shared-locks'); let requests = 0;
    const engine = new SmartEngine(new Store(join(f.root, 'private-metadata'), locks), async () => ({
      catalog: async () => [], create: async () => '', abort: async () => true, close() {}, prompt: async () => { requests++; throw new Error('never called'); },
    }));
    const release = await lockProject(f.repo, locks);
    try { await expect(engine.run({ objective: 'Fix parser', projectPath: f.repo, config: f.config })).rejects.toThrow('locked'); }
    finally { await release(); }
    expect(requests).toBe(0);
    const task = await f.factory.run(f.spec);
    const deliveryStore = new FactoryStore(f.store.root, locks);
    const releaseDelivery = await lockProject(task.workspace!.path, locks); let approvals = 0;
    try {
      const result = await new DeliveryManager(deliveryStore, async () => { approvals++; return true; }).deliver(task.id);
      expect(result.delivery?.commit).toBeUndefined(); expect(approvals).toBe(0);
    } finally { await releaseDelivery(); }
  } finally { await f.cleanup(); }
});
