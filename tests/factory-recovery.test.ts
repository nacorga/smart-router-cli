import { it, expect } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './factory-helpers.js';
import { Factory } from '../src/factory/orchestrator.js';
import type { EngineHandle, ExecutionEngine } from '../src/engine/index.js';
it('retains stale locks and uncertain journals without replaying operations', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec);
    task.state = 'EXECUTING'; task.pid = 2147483647; task.operation = { id: randomUUID(), kind: 'engine-run' }; await f.store.save(task);
    const count = f.requests();
    expect((await f.factory.inspect(task.id)).state).toBe('BLOCKED'); expect(f.requests()).toBe(count);
    await expect(f.factory.continue(task.id)).rejects.toThrow('INSPECTION');
    // A deliberately retained lock is never automatically deleted.
    await expect(f.store.lock('another-task')).rejects.toThrow('INSPECTION');
  } finally { await f.cleanup(); }
});
it('cancels the active engine, retains earlier effects and rejects automatic continuation', async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void, aborts = 0;
  const started = new Promise<void>(r => { entered = r; }), waiting = new Promise<void>(r => { release = r; });
  const engine: ExecutionEngine = {
    run: async input => {
      entered();
      return { taskId: randomUUID(), cancel: async () => { aborts++; release(); return true; }, result: waiting.then(() => ({ id: randomUUID(), status: 'cancelled' } as any)) } satisfies EngineHandle;
    }, inspect: async () => { throw new Error('No checkpoint'); }, continue: async () => { throw new Error('No replay'); },
  };
  const factory = new Factory(f.store, engine, f.config, async () => true, 'offline-fixture');
  try {
    const running = factory.run(f.spec); await started;
    expect((await factory.cancel(f.spec.id)).reason).toContain('REQUESTED');
    const task = await running; expect(task.state).toBe('CANCELLED'); expect(aborts).toBeGreaterThan(0);
    await expect(factory.continue(task.id)).rejects.toThrow();
  } finally { await f.cleanup(); }
});
