import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evaluate, loadCases, schedule, verifyFixtures, reliabilityMetrics, reliabilityPermission, freezePlan, validatePlan, readFrozenPlan, sha, type ReliabilityRow } from '../src/reliability.js';
import { smokeConfig } from '../src/smoke-fixture.js';
const exec = promisify(execFile);
describe('prospective controlled evaluation', () => {
  it('accepts all reference implementations and rejects broken baselines and behavioral mutants', async () => {
    const result = await verifyFixtures(); expect(result.cases).toHaveLength(10); expect(result.cases.every(c => c.killedMutants >= 1)).toBe(true);
  }, 20000);
  it('does not accept an early successful process exit that skipped the judge', async () => {
    const c = (await loadCases())[0]!; expect(await evaluate(c, c.reference + '\nprocess.exit(0);')).toBe(false);
  });
  it('schedules sixty unique paired slots with alternating arm order', async () => {
    const cases = await loadCases(), slots = schedule(cases);
    expect(new Set(cases.map(c => c.project)).size).toBe(3); expect(slots).toHaveLength(60); expect(new Set(slots.map(s => s.id)).size).toBe(60);
    for (const c of cases) for (const repetition of [1, 2, 3]) expect(slots.filter(s => s.caseId === c.id && s.repetition === repetition).map(s => s.arm).sort()).toEqual(['deep-only', 'smart']);
    expect(slots[0]!.arm).not.toBe(slots[20]!.arm);
  });
  it('counts workflow completion separately from acceptance and includes failed costs', async () => {
    const slots = schedule((await loadCases()).slice(0, 2), 1);
    const rows: ReliabilityRow[] = slots.map((s, i) => ({ ...s, status: i === 1 ? 'blocked' : 'completed', accepted: i !== 2, preserved: true, costUsd: 0.1, unknownCost: i === 1, durationMs: 10 }));
    const result = reliabilityMetrics(slots, rows);
    expect(result.knownTotalCostUsd).toBeCloseTo(0.4); expect(result.matchedPairs).toBe(2);
    expect(result.arms.smart!.acceptedCompleted).toBe(2); expect(result.arms['deep-only']!.acceptedCompleted).toBe(0);
    expect(result.arms['deep-only']!.blocked).toBe(1); expect(result.arms['deep-only']!.completedButRejected).toBe(1);
    expect(result.arms['deep-only']!.costPerAcceptedCompletionUsd).toBeNull();
    expect(reliabilityMetrics(slots, rows.slice(0, 1)).arms['deep-only']!.acceptanceAmongAttempted).toBeNull();
    expect(() => reliabilityMetrics(slots, [rows[0]!, rows[0]!])).toThrow('Duplicate');
    expect(() => reliabilityMetrics(slots, [{ ...rows[0]!, arm: 'deep-only' }])).toThrow('frozen');
  });
  it('does not count damaged user work as an accepted completion', async () => {
    const slots = schedule((await loadCases()).slice(0, 1), 1);
    const result = reliabilityMetrics(slots, [{ ...slots[0]!, status: 'completed', accepted: true, preserved: false, costUsd: 0.2, unknownCost: false, durationMs: 10 }]);
    expect(result.arms.smart!.acceptedCompleted).toBe(0); expect(result.arms.smart!.completedButRejected).toBe(1);
  });
  it('rejects editing evaluator files, traversal, shell wrappers and changed workdir', () => {
    const d = '/fixture';
    const description = (header: string, metadata = {}) => header + '\n' + JSON.stringify(metadata);
    expect(reliabilityPermission(d, description('edit: index.mjs'))).toBe(true);
    expect(reliabilityPermission(d, description('bash: npm test', { command: 'npm test', workdir: d }))).toBe(true);
    for (const path of ['visible.test.mjs', '../index.mjs', 'USER-NOTE.txt', 'index.mjs, package.json']) expect(reliabilityPermission(d, description('edit: ' + path))).toBe(false);
    for (const command of ['npm test; true', 'npm test > result', 'node other.mjs']) expect(reliabilityPermission(d, description('bash: ' + command, { command }))).toBe(false);
    expect(reliabilityPermission(d, description('bash: npm test', { command: 'npm test', workdir: '/' }))).toBe(false);
  });
  it('freezes explicit models/config/fixtures and rejects tampered execution inputs', async () => {
    const cfg = smokeConfig(), plan = await freezePlan(cfg, 1, 0.05); await validatePlan(plan);
    const bytes = Buffer.from(JSON.stringify(plan)); await readFrozenPlan(bytes, sha(bytes));
    await expect(readFrozenPlan(Buffer.from(JSON.stringify({ ...plan, budgetUsd: 2 })), sha(bytes))).rejects.toThrow('SHA256');
    const extended = { ...cfg, apiKey: 'must-not-be-frozen' }; expect(JSON.stringify(await freezePlan(extended, 1, 0.05))).not.toContain('must-not-be-frozen');
    const changed = structuredClone(plan); changed.slots.reverse(); await expect(validatePlan(changed)).rejects.toThrow('slots');
    const timeout = structuredClone(plan); timeout.timeoutMs = 1; await expect(validatePlan(timeout)).rejects.toThrow('timeoutMs');
    const changedFixture = structuredClone(plan); changedFixture.fixtureSha256.Q01 = 'wrong'; await expect(validatePlan(changedFixture)).rejects.toThrow('fixtureSha256');
    await expect(freezePlan(cfg, NaN, 0.05)).rejects.toThrow('budget');
    cfg.models.fast = '<FAST_MODEL_ID>'; await expect(freezePlan(cfg, 1, 0.05)).rejects.toThrow('placeholders');
  });
  it('runs every frozen slot in a labelled offline rehearsal with independent checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-rehearse-test-'));
    try {
      const cli = fileURLToPath(new URL('../src/reliability.ts', import.meta.url));
      const plan = await freezePlan(smokeConfig(), 1, 0.05), planPath = join(root, 'plan.json'), output = join(root, 'campaign');
      const bytes = JSON.stringify(plan); await writeFile(planPath, bytes);
      const args = ['--import', 'tsx', cli, '--rehearse', '--plan', planPath, '--plan-sha256', sha(bytes), '--output', output];
      const env = { ...process.env, OPENROUTER_API_KEY: 'invalid-key-no-provider-may-be-used' };
      const { stdout } = await exec(process.execPath, args, { env, timeout: 45000 });
      expect(JSON.parse(stdout).execution).toBe('SIMULATION');
      const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
      expect(summary.stopReason).toBe('finished'); expect(summary.results).toHaveLength(60);
      expect(summary.metrics.matchedPairs).toBe(30); expect(summary.metrics.knownTotalCostUsd).toBe(0); expect(summary.metrics.unknownCost).toBe(false);
      for (const arm of ['smart', 'deep-only']) expect(summary.metrics.arms[arm].acceptedCompleted).toBe(30);
      await expect(exec(process.execPath, args, { env })).rejects.toThrow('EEXIST');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 50000);
  it('previews with a dummy key without starting inference and never overwrites a frozen plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-plan-test-'));
    try {
      const cli = fileURLToPath(new URL('../src/reliability.ts', import.meta.url));
      const env = { ...process.env, OPENROUTER_API_KEY: 'dummy-must-never-be-used' };
      const preview = JSON.parse((await exec(process.execPath, ['--import', 'tsx', cli], { env })).stdout);
      expect(preview.status).toBe('NOT_RUN'); expect(preview.slots).toHaveLength(60);
      const configPath = join(root, 'config.json'), output = join(root, 'plan.json'); await writeFile(configPath, JSON.stringify(smokeConfig()));
      const args = ['--import', 'tsx', cli, '--freeze', '--config', configPath, '--budget', '1', '--per-run-budget', '0.05', '--output', output];
      await exec(process.execPath, args, { env }); const before = await readFile(output, 'utf8');
      await expect(exec(process.execPath, args, { env })).rejects.toThrow('EEXIST'); expect(await readFile(output, 'utf8')).toBe(before);
      await expect(exec(process.execPath, ['--import', 'tsx', cli, '--run'], { env })).rejects.toThrow('--allow-fixture-tools');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
