import { it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prepareFactoryPilot } from '../src/factory-pilot-preparation.js';
import { parseTaskSpec } from '../src/factory/task-spec.js';
import { Factory } from '../src/factory/orchestrator.js';
import { FactoryStore } from '../src/factory/state.js';
import { SmartEngine } from '../src/engine/index.js';
import { Store } from '../src/state.js';
import { NativeTools } from '../src/native-tools.js';
import { git } from '../src/factory/workspace.js';
import { qualityGate } from '../src/factory/quality-gate.js';
import type { Backend, Result } from '../src/types.js';
it('prepares a failing reproducible pilot and explicit approvals without starting an engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-pilot-test-'));
  try {
    const output = join(root, 'pilot'); const prepared = await prepareFactoryPilot(output, 'codex', 'explicit-fixture-model', 'trusted-native-cli');
    expect(prepared).toMatchObject({ status: 'PREPARED_NOT_RUN', baselineExitCode: 1, providerRequests: 0 });
    const spec = parseTaskSpec(JSON.parse(await readFile(prepared.spec, 'utf8')));
    expect(spec.delivery.draftPR).toBe(false); expect(spec.scope.allowedPaths).toEqual(['index.mjs']);
    const config = JSON.parse(await readFile(prepared.config, 'utf8')); expect(config.limits).toMatchObject({ maxCostUsd: 0, maxModelCalls: 3, repairAttemptsBeforeEscalation: 0 });
    expect((await stat(prepared.config)).mode & 0o777).toBe(0o600);
    await expect(prepareFactoryPilot(output, 'codex', 'model', 'trusted')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

it('completes the prepared three-prompt pilot with multi-record subscription telemetry and real independent tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-pilot-regression-'));
  try {
    const prepared = await prepareFactoryPilot(join(root, 'pilot'), 'codex', 'scripted-model', 'never-start-this-cli');
    const spec = parseTaskSpec(JSON.parse(await readFile(prepared.spec, 'utf8')));
    const config = JSON.parse(await readFile(prepared.config, 'utf8'));
    const original = await readFile(join(spec.repository.path, 'index.mjs'), 'utf8');
    const store = new FactoryStore(join(root, 'state')); let calls = 0;
    const approvals: string[] = [];
    const engine = new SmartEngine(new Store(join(store.root, 'engine'), store.projectLockRoot), async (_d, project, approve) => ({
      catalog: async () => [{ id: 'scripted-model', tools: true, context: 200000 }],
      create: async () => 'scripted-session', abort: async () => true, close() {},
      prompt: async (_session, _model, _prompt, stage): Promise<Result> => {
        calls++;
        const broker = new NativeTools(project, stage, approve, new AbortController().signal);
        if (stage === 'implement') await broker.call('write_file', { path: 'index.mjs', content: "export const parseLines = input => input === '' ? [] : input.split(/\\r?\\n/);\n" });
        if (stage === 'implement') await broker.call('run_command', { command: 'npm test' });
        if (stage === 'implement' || stage === 'validate') await broker.call('run_command', { command: 'node --test test.mjs' });
        return {
          text: 'Scripted fixture; only process evidence counts.', validation: broker.evidence.some(e => e.endsWith(':failed')) ? 'failed' : broker.evidence.length ? 'passed' : 'none',
          evidence: broker.evidence, toolsExecuted: broker.touched, failure: broker.denied ? 'permission' : undefined,
          usage: Array.from({ length: 5 }, (_, i) => ({ messageId: `${calls}:${i}`, inputTokens: 10, outputTokens: 1, source: 'backend' as const })),
        };
      },
    } satisfies Backend));
    const factory = new Factory(store, engine, config, async details => {
      approvals.push(details);
      return details.startsWith('edit: index.mjs\n') || details.startsWith('bash: npm test\n') || details.startsWith('bash: node --test test.mjs\n') || details.startsWith('Run ONE independent validation');
    }, 'offline-fixture');
    const task = await factory.run(spec);
    expect(task.state).toBe('AWAITING_DELIVERY_APPROVAL'); expect(calls).toBe(3);
    expect(task.engineSummary).toMatchObject({ calls: 3, usageRecords: 15, apiSpentUsd: 0, subscriptionCostUsd: null });
    expect(task.checks).toHaveLength(1); expect(task.checks[0]).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(approvals.filter(d => d.startsWith('edit:'))).toHaveLength(1);
    expect(approvals.filter(d => d.startsWith('bash:'))).toHaveLength(3);
    expect(approvals.filter(d => d.startsWith('bash: node --test test.mjs\n'))).toHaveLength(2);
    expect(task.approvals).toHaveLength(approvals.length);
    expect(approvals.filter(d => d.startsWith('Run ONE independent validation'))).toHaveLength(1);
    await expect(qualityGate(task)).resolves.toBeUndefined();
    expect((await git(task.workspace!.path, ['diff', '--name-only'])).trim()).toBe('index.mjs');
    expect(await readFile(join(spec.repository.path, 'index.mjs'), 'utf8')).toBe(original);
    expect((await git(spec.repository.path, ['status', '--porcelain'])).trim()).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
