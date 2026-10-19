import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContinuityController } from '../src/continuity.js';
import { ContinuityStore, coordination, projectFingerprint } from '../src/continuity-state.js';
import { subscriptionTemplate, validateConfig } from '../src/config.js';
import { Store } from '../src/state.js';
import { summary } from '../src/cli.js';
import type { Backend, Config, Destination, PortableTask, Result } from '../src/types.js';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function setup(order = ['codex', 'claude']) {
  const root = await mkdtemp(join(tmpdir(), 'smart-continuity-')); roots.push(root);
  await exec('git', ['init', root]); await writeFile(join(root, 'user.txt'), 'existing work');
  await exec('git', ['-C', root, 'add', 'user.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-m', 'Fixture']);
  const config = subscriptionTemplate(); config.limits.maxCostUsd = 0;
  config.destinations = order.map(id => ({ id, backend: id, billing: 'subscription', models: { fast: id + '/fast', balanced: id + '/balanced', deep: id + '/deep' } } as Destination));
  // State must be outside the project fingerprint.
  const storeRoot = await mkdtemp(join(tmpdir(), 'smart-continuity-state-')); roots.push(storeRoot);
  const store = new Store(storeRoot), calls: string[] = [];
  const ok = (): Result => ({ text: 'private observations', usage: [{ messageId: String(calls.length), inputTokens: 1, outputTokens: 1, source: 'backend' }], validation: 'passed', evidence: ['actual-check:passed'], toolsExecuted: false });
  const quota = (): Result => ({ text: '', usage: [], failure: 'quota', validation: 'none', evidence: [], toolsExecuted: false, rejectedBeforeTools: true });
  const backend = (d: Destination, run: () => Promise<Result>): Backend => ({ identity: d.id, billing: d.billing, catalog: async () => Object.values(d.models).map(id => ({ id, tools: true, context: 200000 })), create: async () => 'session-' + d.id, prepare: async () => {}, prompt: async () => { calls.push(d.id); return run(); }, abort: async () => true, close: async () => {} });
  return { root, config, store, calls, ok, quota, backend };
}
describe('portable sequential continuity', () => {
  it.each([['codex', 'claude'], ['claude', 'codex']])('continues %s -> %s at zero API budget', async (first, second) => {
    const f = await setup([first, second]);
    const controller = new ContinuityController(async d => f.backend(d, async () => d.id === first ? f.quota() : f.ok()), f.config, f.store, () => {});
    const task = await controller.run('Implement a parser', f.root);
    expect(task.status).toBe('completed'); expect(f.calls).toEqual([first, second, second, second]);
    expect(task.spent).toBe(0); expect(task.unknownCost).toBe(false); expect(task.transitions).toHaveLength(2);
    expect(task.transitions.every(t => t.state === 'committed')).toBe(true);
    expect(await readFile(join(f.root, 'user.txt'), 'utf8')).toBe('existing work');
    const handoff = await new ContinuityStore(f.store).get(task.id);
    expect(handoff.objective).toBe('Implement a parser');
    expect(JSON.stringify(summary(task))).not.toContain('private observations');
    expect(coordination(task)).not.toContain('session-');
    expect((await stat(join(f.store.root, 'handoffs', task.id + '.json'))).mode & 0o777).toBe(0o600);
  });
  it.each(['permission', 'limit', 'authentication', 'infrastructure'] as const)('does not fail over for %s', async failure => {
    const f = await setup(); const c = new ContinuityController(async d => f.backend(d, async () => ({ ...f.ok(), failure })), f.config, f.store, () => {});
    const task = await c.run('Implement a parser', f.root); expect(task.status).toBe('blocked'); expect(f.calls).toEqual(['codex']);
  });
  it('blocks quota after tools and does not replay on continuation', async () => {
    const f = await setup(); const c = new ContinuityController(async d => f.backend(d, async () => ({ ...f.quota(), toolsExecuted: true })), f.config, f.store, () => {});
    const task = await c.run('Implement a parser', f.root); expect(task.requestState).toBe('uncertain');
    const next = new ContinuityController(c.factory, f.config, f.store, () => {});
    await expect(next.continue(task.id, f.root)).rejects.toThrow('INSPECTION_REQUIRED'); expect(f.calls).toHaveLength(1);
  });
  it('does not infer a quota rejection from absent tool metadata', async () => {
    const f = await setup(); const c = new ContinuityController(async d => f.backend(d, async () => ({ ...f.quota(), toolsExecuted: undefined })), f.config, f.store, () => {});
    expect((await c.run('Implement a parser', f.root)).requestState).toBe('uncertain'); expect(f.calls).toHaveLength(1);
  });
  it('stops when both subscriptions are exhausted without invoking API', async () => {
    const f = await setup(); const c = new ContinuityController(async d => f.backend(d, async () => f.quota()), f.config, f.store, () => {});
    const task = await c.run('Implement a parser', f.root); expect(task.note).toBe('NO_ELIGIBLE_DESTINATION'); expect(f.calls).toEqual(['codex', 'claude']);
  });
  it('keeps manual override pinned', async () => {
    const f = await setup(); f.config.mode = 'manual'; const c = new ContinuityController(async d => f.backend(d, async () => f.quota()), f.config, f.store, () => {});
    expect((await c.run('Implement a parser', f.root)).note).toBe('PINNED_DESTINATION_UNAVAILABLE'); expect(f.calls).toEqual(['codex']);
  });
  it('does not reset global request limit across destinations or continuation', async () => {
    const f = await setup(); f.config.limits.maxModelCalls = 1; const factory = async (d: Destination) => f.backend(d, async () => f.quota());
    const task = await new ContinuityController(factory, f.config, f.store, () => {}).run('Implement a parser', f.root);
    expect(task.calls).toBe(1); expect(task.note).toBe('BUDGET_OR_CALL_LIMIT');
    const next = await new ContinuityController(factory, f.config, f.store, () => {}).continue(task.id, f.root);
    expect(next.calls).toBe(1); expect(f.calls).toHaveLength(1);
  });
  it('detects modified content even when Git status stays dirty', async () => {
    const f = await setup(); await writeFile(join(f.root, 'user.txt'), 'first'); const a = await projectFingerprint(f.root);
    await writeFile(join(f.root, 'user.txt'), 'second'); expect(await projectFingerprint(f.root)).not.toBe(a);
  });
  it('rejects continuation after external file changes', async () => {
    const f = await setup(); f.config.limits.maxModelCalls = 1; const factory = async (d: Destination) => f.backend(d, async () => f.ok());
    const task = await new ContinuityController(factory, f.config, f.store, () => {}).run('Implement a parser', f.root);
    await writeFile(join(f.root, 'new.txt'), 'external');
    await expect(new ContinuityController(factory, f.config, f.store, () => {}).continue(task.id, f.root)).rejects.toThrow('PROJECT_CHANGED');
  });
  it('requires inspection of prepared transitions even with an idle session', async () => {
    const f = await setup(); f.config.limits.maxModelCalls = 1; const factory = async (d: Destination) => f.backend(d, async () => f.ok());
    const task = await new ContinuityController(factory, f.config, f.store, () => {}).run('Implement a parser', f.root);
    task.transitions.at(-1)!.state = 'prepared'; await f.store.save(task);
    await expect(new ContinuityController(factory, f.config, f.store, () => {}).continue(task.id, f.root)).rejects.toThrow('INSPECTION_REQUIRED');
  });
  it('rejects unknown versions and duplicate/invalid destinations', async () => {
    const f = await setup(); expect(() => validateConfig({ ...f.config, schemaVersion: 3 })).toThrow();
    expect(() => validateConfig({ ...f.config, destinations: [f.config.destinations![0], f.config.destinations![0]] })).toThrow();
    expect(() => validateConfig({ ...f.config, destinations: [{ ...f.config.destinations![0], billing: 'api' }] })).toThrow();
  });
});

it('rejects symlinks and excludes secret content from project fingerprints', async () => {
  const { symlink } = await import('node:fs/promises'); const { safeProjectPath } = await import('../src/continuity-state.js');
  const root = await mkdtemp(join(tmpdir(), 'smart-path-fixture-')); roots.push(root);
  await writeFile(join(root, '.env'), 'fixture-secret'); await symlink(join(root, '.env'), join(root, 'link'));
  await expect(safeProjectPath(root, '.env')).rejects.toThrow('PATH_DENIED');
  await expect(safeProjectPath(root, 'link')).rejects.toThrow('SYMLINK_DENIED');
  await expect(safeProjectPath(root, '../outside')).rejects.toThrow('PATH_DENIED');
});

it('keeps CLI exports and coordination separate from explicit private inspection', async () => {
  const f = await setup();
  const task = await new ContinuityController(async d => f.backend(d, async () => f.ok()), f.config, f.store, () => {}).run('Implement PRIVATE_OBJECTIVE_MARKER', f.root);
  const { fileURLToPath } = await import('node:url'); const { createRequire } = await import('node:module');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (flag: string) => exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), cli, flag, task.id], { cwd: f.root, env: { ...process.env, SMART_STATE_DIR: f.store.root } });
  expect((await run('--export')).stdout).not.toContain('PRIVATE_OBJECTIVE_MARKER');
  expect((await run('--coordination')).stdout).not.toContain('PRIVATE_OBJECTIVE_MARKER');
  expect((await run('--handoff')).stdout).toContain('PRIVATE_OBJECTIVE_MARKER');
});

it('does not reuse a passed check from an earlier stage after a later unverified edit', async () => {
  const f = await setup();
  const c = new ContinuityController(async d => f.backend(d, async () => {
    if (f.calls.length === 3) { await writeFile(join(f.root, 'new-file.txt'), 'changed after earlier checks'); return { ...f.ok(), validation: 'none', evidence: [], toolsExecuted: true }; }
    return f.ok();
  }), f.config, f.store, () => {});
  expect((await c.run('Implement a parser', f.root)).status).toBe('unverified');
});

it('retains repair evidence and escalation counters across a quota handoff', async () => {
  const f = await setup();
  const c = new ContinuityController(async d => f.backend(d, async () => {
    if (f.calls.length === 3) return f.quota();
    if (f.calls.length === 2 || f.calls.length === 4) return { ...f.ok(), validation: 'failed', failure: 'implementation', evidence: ['same-check:failed'] };
    return f.ok();
  }), f.config, f.store, () => {});
  const task = await c.run('Implement a parser', f.root);
  expect(task.status).toBe('completed'); expect(task.stageCounters['2']!.escalations).toBe(1);
  expect(task.stages[1]!.decisions.map(d => d.tier)).toEqual(['balanced', 'balanced', 'balanced', 'deep']);
  expect(f.calls).toEqual(['codex', 'codex', 'codex', 'claude', 'claude', 'claude']);
});

it('retains repair counters and prior failure evidence across explicit continuation', async () => {
  const f = await setup(); f.config.limits.maxModelCalls = 2;
  const factory = async (d: Destination) => f.backend(d, async () => f.calls.length === 1 ? f.ok() : ({ ...f.ok(), validation: 'failed', failure: 'implementation', evidence: ['same-check:failed'] }));
  const first = await new ContinuityController(factory, f.config, f.store, () => {}).run('Implement a parser', f.root);
  expect(first.stageCounters['2']!.repairs).toBe(1); expect(first.note).toBe('BUDGET_OR_CALL_LIMIT');
  f.config.limits.maxModelCalls = 4;
  const next = await new ContinuityController(factory, f.config, f.store, () => {}).continue(first.id, f.root);
  expect(next.calls).toBe(4); expect(next.stageCounters['2']!.escalations).toBe(1); expect(next.status).toBe('failed');
  expect(next.stages[1]!.decisions.map(d => d.tier)).toEqual(['balanced', 'balanced', 'deep']);
});

it('preserves env-file exclusions for suffixes and alternate env filenames', async () => {
  const { secretPath } = await import('../src/continuity-state.js');
  expect(['.env', '.envrc', '.env-production', 'config.env', 'nested/config.env.backup'].every(secretPath)).toBe(true);
});

it('rejects shared state directories without changing their permissions', async () => {
  const { chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'smart-shared-state-')); roots.push(root); await chmod(root, 0o755);
  const store = new ContinuityStore(new Store(root));
  await expect(store.save({ schemaVersion: 2, taskId: crypto.randomUUID(), objective: 'private', observations: '', observationsTrusted: false, constraints: [], fingerprint: 'fixture', evidence: [] })).rejects.toThrow('PRIVATE_STATE_PERMISSIONS_REQUIRED');
  expect((await stat(root)).mode & 0o777).toBe(0o755);
});


it('refreshes exhaustion only on explicit continuation while preserving task counters', async () => {
  const f = await setup(); let reset = false;
  const factory = async (d: Destination) => f.backend(d, async () => reset ? f.ok() : f.quota());
  const first = await new ContinuityController(factory, f.config, f.store, () => {}).run('Implement a parser', f.root);
  expect(first.note).toBe('NO_ELIGIBLE_DESTINATION'); expect(first.calls).toBe(2);
  reset = true;
  const next = await new ContinuityController(factory, f.config, f.store, () => {}).continue(first.id, f.root);
  expect(next.status).toBe('completed'); expect(next.note).toBeUndefined(); expect(next.calls).toBe(5); expect(next.id).toBe(first.id);
});


it.each(['SMART_AUTH_REQUIRED', 'EACCES', 'AMBIGUOUS'])('does not fail over after a %s startup failure', async code => {
  const f = await setup(); const created: string[] = [];
  const c = new ContinuityController(async d => { created.push(d.id); throw Object.assign(new Error('Fixture startup failure'), { code }); }, f.config, f.store, () => {});
  expect((await c.run('Implement a parser', f.root)).status).toBe('blocked'); expect(created).toEqual(['codex']);
});


it('keeps an explicit cancellation cancelled when the backend reports uncertain tool effects', async () => {
  const f = await setup();
  const c = new ContinuityController(async d => f.backend(d, async () => {
    await c.cancel(); return { ...f.ok(), failure: 'uncertain', toolsExecuted: true };
  }), f.config, f.store, () => {});
  const task = await c.run('Implement a parser', f.root);
  expect(task.status).toBe('cancelled'); expect(task.requestState).toBe('uncertain'); expect(f.calls).toEqual(['codex']);
  await expect(new ContinuityController(c.factory, f.config, f.store, () => {}).continue(task.id, f.root)).rejects.toThrow('INSPECTION_REQUIRED_NO_REPLAY');
  expect(f.calls).toHaveLength(1);
});
