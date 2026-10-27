import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-helpers.js';
import { git } from '../src/factory/workspace.js';
import { digest } from '../src/factory/approvals.js';

it.each(['allow', 'deny', 'throw'] as const)('journals one decision and executes validation only when approved: %s', async mode => {
  const displayed: string[] = [];
  const f = await fixture('single-validation-' + mode, 'correct', async description => {
    displayed.push(description);
    if (!description.startsWith('Run ONE independent')) return true;
    if (mode === 'throw') throw new Error('Host approval unavailable');
    return mode === 'allow';
  });
  try {
    const marker = join(f.root, 'validation-executions');
    await writeFile(join(f.repo, 'test.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'executed\\n');\n` + await readFile(join(f.repo, 'test.mjs'), 'utf8'));
    await git(f.repo, ['add', '--', 'test.mjs']); await git(f.repo, ['commit', '-m', 'Instrument fixture validation']);
    const task = await f.factory.run(f.spec);
    const validationDescription = displayed.find(d => d.startsWith('Run ONE independent'))!;
    expect(displayed.filter(d => d.startsWith('Run ONE independent'))).toHaveLength(1);
    expect(task.approvals).toHaveLength(displayed.length);
    const decisions = task.approvals.filter(a => a.digest === digest(validationDescription));
    expect(decisions).toHaveLength(1); expect(decisions[0]!.granted).toBe(mode === 'allow');
    expect(task.events.filter(e => e.operationId === decisions[0]!.operationId).map(e => e.type)).toEqual(['approval-requested', mode === 'allow' ? 'approval-granted' : 'approval-denied']);
    const saved = await f.store.get(task.id); expect(saved.approvals).toEqual(task.approvals);
    if (mode === 'allow') {
      expect(task.state).toBe('AWAITING_DELIVERY_APPROVAL');
      expect(task.checks[0]).toMatchObject({ status: 'passed', exitCode: 0 });
      expect(await readFile(marker, 'utf8')).toBe('executed\n');
    } else {
      expect(task.state).toBe('BLOCKED');
      expect(task.checks[0]).toMatchObject({ status: 'blocked', exitCode: null, reason: 'PERMISSION_DENIED' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await f.cleanup(); }
}, 20000);

it('journals pending validation once and denies it on cancellation even if the host approves later', async () => {
  let entered!: () => void, respond!: (approved: boolean) => void;
  const pending = new Promise<void>(r => { entered = r; });
  const f = await fixture('cancel-validation-approval', 'correct', async description => {
    if (!description.startsWith('Run ONE independent')) return true;
    entered(); return new Promise<boolean>(r => { respond = r; });
  });
  const running = f.factory.run(f.spec);
  try {
    await pending;
    const before = await f.store.get(f.spec.id);
    const outstanding = before.events.filter(e => e.type === 'approval-requested' && !before.approvals.some(a => a.operationId === e.operationId));
    expect(outstanding).toHaveLength(1);
    await f.factory.cancel(f.spec.id);
    const task = await running;
    expect(task.state).toBe('CANCELLED'); expect(task.operation).toBeUndefined();
    expect(task.checks[0]).toMatchObject({ exitCode: null, reason: 'PERMISSION_DENIED' });
    const decisions = task.approvals.filter(a => a.operationId === outstanding[0]!.operationId);
    expect(decisions).toHaveLength(1); expect(decisions[0]!.granted).toBe(false);
    const saved = await readFile(join(f.store.root, task.id + '.json'), 'utf8');
    respond(true); await new Promise(r => setImmediate(r));
    expect(await readFile(join(f.store.root, task.id + '.json'), 'utf8')).toBe(saved);
  } finally {
    await f.factory.cancel(f.spec.id).catch(() => {});
    respond?.(false); await running.catch(() => {}); await f.cleanup();
  }
}, 20000);
