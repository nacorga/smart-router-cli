import { it, expect, vi } from 'vitest';
vi.setConfig({ testTimeout: 20000 });
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-helpers.js';
import { qualityGate } from '../src/factory/quality-gate.js';
import { Factory } from '../src/factory/orchestrator.js';
import { git } from '../src/factory/workspace.js';
import { DeliveryManager } from '../src/factory/delivery.js';
it('runs the actual engine and independent checks through verified local delivery', async () => {
  const f = await fixture();
  try {
    const original = await git(f.repo, ['status', '--porcelain']), head = await git(f.repo, ['rev-parse', 'HEAD']);
    const task = await f.factory.run(f.spec);
    expect(task.state).toBe('AWAITING_DELIVERY_APPROVAL'); expect(task.mode).toBe('offline-fixture');
    expect(task.engineStatus).toBe('unverified'); // prose supplied no evidence
    expect(task.checks[0]).toMatchObject({ exitCode: 0, status: 'passed', contentHash: task.validatedHash });
    expect(task.approvals.every(a => a.granted)).toBe(true); expect(task.operation).toBeUndefined();
    expect((await stat(join(f.store.root, `${task.id}.json`))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(task.events)).not.toContain('PRIVATE_FIXTURE_SECRET');
    expect(await f.factory.continue(task.id)).toMatchObject({ state: 'AWAITING_DELIVERY_APPROVAL' });
    const denied = new DeliveryManager(f.store); expect((await denied.deliver(task.id)).state).toBe('AWAITING_DELIVERY_APPROVAL');
    expect(await git(task.workspace!.path, ['rev-parse', 'HEAD'])).toBe(head);
    const delivered = await new DeliveryManager(f.store, async () => true).deliver(task.id);
    expect(delivered.state).toBe('READY_LOCAL'); expect(delivered.delivery?.commit).toBeTruthy();
    expect(await git(f.repo, ['rev-parse', 'HEAD'])).toBe(head); expect(await git(f.repo, ['status', '--porcelain'])).toBe(original);
    expect(await readFile(join(f.repo, 'user.txt'), 'utf8')).toBe('PREVIOUS_USER_CHANGE');
    const saved = await readFile(join(f.store.root, `${task.id}.json`), 'utf8'); expect(saved).not.toContain('PRIVATE_FIXTURE_SECRET');
    await expect(f.factory.run(f.spec)).rejects.toThrow();
  } finally { await f.cleanup(); }
});
it.each(['broken', 'protected', 'outside', 'denied', 'uncertain'] as const)('blocks a %s implementation independently of success claims', async behavior => {
  const f = await fixture('negative-' + behavior, behavior);
  try {
    const task = await f.factory.run(f.spec);
    expect(['BLOCKED', 'FAILED']).toContain(task.state);
    if (behavior === 'broken') expect(task.checks[0]).toMatchObject({ status: 'failed', exitCode: 1 });
    if (behavior === 'denied') expect(task.engineStatus).toBe('blocked');
    expect(task.delivery).toBeUndefined();
    expect(await readFile(join(f.repo, '.env'), 'utf8')).toBe('PRIVATE_FIXTURE_SECRET');
    expect(JSON.stringify(task.events)).not.toContain('PRIVATE_FIXTURE_SECRET');
  } finally { await f.cleanup(); }
});
it('invalidates checks after any later modification, including during delivery approval', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec); const path = join(task.workspace!.path, 'index.mjs');
    await writeFile(path, 'export const sum = () => 999;\n');
    await expect(qualityGate(task)).rejects.toThrow('STALE');
    let approvals = 0;
    await new DeliveryManager(f.store, async () => { approvals++; return true; }).deliver(task.id);
    expect(approvals).toBe(0); expect((await f.store.get(task.id)).delivery).toBeUndefined();
  } finally { await f.cleanup(); }
});
it('denies independent commands without TaskSpec conferring authority', async () => {
  const f = await fixture('deny-validation', 'correct', async d => !d.startsWith('Run ONE independent'));
  try { const task = await f.factory.run(f.spec); expect(task.state).toBe('BLOCKED'); expect(task.checks[0]).toMatchObject({ status: 'blocked', exitCode: null, reason: 'PERMISSION_DENIED' }); }
  finally { await f.cleanup(); }
});
it('rejects a protected staged-only change even if working bytes match the base', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec), path = join(task.workspace!.path, 'test.mjs');
    const before = await readFile(path, 'utf8');
    await writeFile(path, 'altered staged test'); await git(task.workspace!.path, ['add', '--', 'test.mjs']); await writeFile(path, before);
    await expect(qualityGate(task)).rejects.toThrow('PROTECTED');
    const result = await new DeliveryManager(f.store, async () => true).deliver(task.id); expect(result.delivery).toBeUndefined();
  } finally { await f.cleanup(); }
});
