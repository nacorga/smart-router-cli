import { readFile, writeFile, mkdir, mkdtemp, readdir, lstat, rm, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, requireConfigured } from './config.js';
import { loadLocalEnv } from './env.js';
import type { Backend, Config, Task } from './types.js';
import { Controller } from './controller.js';
import { Store } from './state.js';
import { validationEvidence, OpenCodeBackend } from './opencode.js';
import { OpenRouterMeter, meteredBackend } from './openrouter-meter.js';

export interface ReliabilityCase {
  id: string; project: string; name: string; prompt: string; baseline: string; reference: string;
  mutants: { name: string; source: string }[];
  checks: { args: unknown[]; expected?: unknown; throws?: string }[];
}
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
const base = fileURLToPath(new URL('..', import.meta.url));
export const casesPath = join(base, 'benchmark/reliability/cases.json');
export async function loadCases(): Promise<ReliabilityCase[]> { return JSON.parse(await readFile(casesPath, 'utf8')); }
export function fixtureFiles(c: ReliabilityCase): Record<string, string> {
  return {
    'index.mjs': c.baseline + '\n',
    'package.json': JSON.stringify({ name: c.project, private: true, type: 'module', scripts: { test: 'node --test visible.test.mjs' } }, null, 2) + '\n',
    'visible.test.mjs': judge(c, c.checks.slice(0, 1)),
    'USER-NOTE.txt': 'Pre-existing user work. Preserve this file byte for byte.\n',
    'README.md': `# ${c.project}\nControlled dependency-free evaluation fixture, not a real-world repository.\n\n${c.prompt}\n`,
  };
}
function judge(c: ReliabilityCase, checks = c.checks, completionMarker?: string) {
  return `import assert from 'node:assert/strict';\nimport { ${c.name} as fn } from './index.mjs';\nconst checks = ${JSON.stringify(checks)};\nfor(const c of checks){const args=structuredClone(c.args),before=structuredClone(args);if(c.throws){assert.throws(()=>fn(...args),{name:c.throws});}else{assert.deepStrictEqual(fn(...args),c.expected);}assert.deepStrictEqual(args,before,'input mutation');}\n${completionMarker ? `console.log(${JSON.stringify(completionMarker)});` : ''}\n`;
}
/** Run only copied candidate bytes and a harness-owned judge outside the model workspace. Not an OS sandbox. */
export async function evaluate(c: ReliabilityCase, source: string): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'smart-independent-'));
  try {
    await writeFile(join(root, 'index.mjs'), source);
    const completionMarker = 'SMART_CHECKS_COMPLETED_' + randomUUID();
    await writeFile(join(root, 'judge.mjs'), judge(c, c.checks, completionMarker));
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
    try { const { stdout } = await exec(process.execPath, ['judge.mjs'], { cwd: root, env, timeout: 5000, maxBuffer: 128 * 1024 }); return stdout.trimEnd().split('\n').at(-1) === completionMarker; }
    catch { return false; }
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function verifyFixtures() {
  const cases = await loadCases(); const checked = [];
  for (const c of cases) {
    if (!await evaluate(c, c.reference)) throw new Error(`${c.id}: reference rejected`);
    if (await evaluate(c, c.baseline)) throw new Error(`${c.id}: broken baseline accepted`);
    for (const mutant of c.mutants) if (await evaluate(c, mutant.source)) throw new Error(`${c.id}: surviving mutant ${mutant.name}`);
    checked.push({ caseId: c.id, referenceAccepted: true, baselineRejected: true, killedMutants: c.mutants.length });
  }
  return { status: 'passed', kind: 'harness-self-check', cases: checked, realProviderInferenceRequests: 0, billableCostUsd: 0 };
}
export interface Slot { id: string; caseId: string; repetition: number; arm: 'smart' | 'deep-only' }
export function schedule(cases: ReliabilityCase[], repetitions = 3): Slot[] {
  return Array.from({ length: repetitions }, (_, repetition) => cases.flatMap((c, i) =>
    ((i + repetition) % 2 ? ['deep-only', 'smart'] : ['smart', 'deep-only']).map(arm => ({
      id: `${c.id}-r${repetition + 1}-${arm}`, caseId: c.id, repetition: repetition + 1, arm: arm as Slot['arm'],
    })))).flat();
}
export interface ReliabilityRow extends Slot {
  status: Task['status'] | 'harness-error'; accepted: boolean; preserved: boolean;
  costUsd: number; unknownCost: boolean; durationMs: number; note?: string; permissionDenials?: number;
}
export function reliabilityMetrics(slots: Slot[], rows: ReliabilityRow[]) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate result slot');
  for (const row of rows) {
    const slot = slots.find(s => s.id === row.id);
    if (!slot || slot.caseId !== row.caseId || slot.arm !== row.arm || slot.repetition !== row.repetition) throw new Error('Result does not match frozen slot');
    if (!Number.isFinite(row.costUsd) || row.costUsd < 0 || !Number.isFinite(row.durationMs) || row.durationMs < 0) throw new Error('Invalid result measurement');
  }
  const arms = Object.fromEntries(['smart', 'deep-only'].map(arm => {
    const group = rows.filter(r => r.arm === arm), planned = slots.filter(s => s.arm === arm).length;
    const acceptedCompleted = group.filter(r => r.status === 'completed' && r.accepted && r.preserved).length;
    const knownCostUsd = group.reduce((sum, r) => sum + r.costUsd, 0), unknownCost = group.some(r => r.unknownCost);
    return [arm, { planned, attempted: group.length, pending: planned - group.length, acceptedCompleted,
      completedButRejected: group.filter(r => r.status === 'completed' && (!r.accepted || !r.preserved)).length,
      failed: group.filter(r => r.status === 'failed').length, unverified: group.filter(r => r.status === 'unverified').length, harnessErrors: group.filter(r => r.status === 'harness-error').length,
      blocked: group.filter(r => r.status === 'blocked').length, permissionDenialAttempts: group.reduce((n, r) => n + (r.permissionDenials ?? 0), 0), cancelled: group.filter(r => r.status === 'cancelled').length,
      acceptanceAmongAttempted: group.length ? acceptedCompleted / group.length : null,
      knownCostUsd, unknownCost, costPerAcceptedCompletionUsd: !unknownCost && acceptedCompleted ? knownCostUsd / acceptedCompleted : null,
      maxDurationMs: group.length ? Math.max(...group.map(r => r.durationMs)) : null }];
  }));
  const matchedPairs = slots.filter(s => s.arm === 'smart').filter(s => rows.some(r => r.id === s.id) && rows.some(r => r.caseId === s.caseId && r.repetition === s.repetition && r.arm === 'deep-only')).length;
  return { arms, matchedPairs, knownTotalCostUsd: rows.reduce((sum, r) => sum + r.costUsd, 0), unknownCost: rows.some(r => r.unknownCost),
    interpretation: 'Controlled public fixtures, not a blinded holdout or real-repository evidence. Repetitions are correlated; no population reliability, quality equivalence or savings claim. Pending slots are not failures or successes. All attempted rows remain in cost totals.' };
}
export interface FrozenPlan {
  schemaVersion: 1; kind: 'controlled-public-fixtures'; createdAt: string; sourceSha256: string; suiteSha256: string;
  sourceVersion: { commit: string | null; dirty: boolean | null };
  config: Config; budgetUsd: number; perRunBudgetUsd: number; timeoutMs: number; slots: Slot[]; fixtureSha256: Record<string, string>;
}
export async function sourceFingerprint() {
  // Source checkouts and independent package installs have different frozen fingerprints.
  const files: string[] = [];
  for (const directory of ['src', 'dist']) {
    let entries: string[];
    try { entries = await readdir(join(base, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Source entry points do not depend on stale build artifacts.
    if (directory === 'dist' && import.meta.url.endsWith('.ts')) continue;
    for (const file of entries.sort()) if (/\.(?:ts|js)$/.test(file)) files.push(`${directory}/${file}`);
  }
  files.push('package.json');
  try { await lstat(join(base, 'package-lock.json')); files.push('package-lock.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return sha(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    files: await Promise.all(files.map(async file => [file, sha(await readFile(join(base, file)))])) }));
}
export async function freezePlan(config: Config, budgetUsd: number, perRunBudgetUsd: number): Promise<FrozenPlan> {
  validateConfig(config); requireConfigured(config);
  // Whitelist config fields; do not freeze arbitrary credential/provider extensions.
  config = { mode: config.mode, provider: config.provider, models: { fast: config.models.fast, balanced: config.models.balanced, deep: config.models.deep },
    ...(config.fallbacks ? { fallbacks: { fast: config.fallbacks.fast, balanced: config.fallbacks.balanced, deep: config.fallbacks.deep } } : {}),
    minContext: config.minContext, limits: { maxCostUsd: config.limits.maxCostUsd, maxModelCalls: config.limits.maxModelCalls, maxEscalationsPerStage: config.limits.maxEscalationsPerStage, repairAttemptsBeforeEscalation: config.limits.repairAttemptsBeforeEscalation, maxInfrastructureRetries: config.limits.maxInfrastructureRetries } };
  if (config.provider !== 'openrouter' || Object.values(config.models).some(m => !m.startsWith('openrouter/'))) throw new Error('Evaluation requires explicit openrouter/model IDs');
  if (![budgetUsd, perRunBudgetUsd].every(n => Number.isFinite(n) && n > 0) || perRunBudgetUsd > config.limits.maxCostUsd || perRunBudgetUsd > budgetUsd) throw new Error('Invalid campaign/per-run budget');
  const cases = await loadCases();
  let sourceVersion: FrozenPlan['sourceVersion'] = { commit: null, dirty: null };
  try { sourceVersion = { commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: base })).stdout.trim(), dirty: !!(await exec('git', ['status', '--porcelain'], { cwd: base })).stdout.trim() }; } catch { /* Installed packages may have no Git checkout. */ }
  return { schemaVersion: 1, kind: 'controlled-public-fixtures', createdAt: new Date().toISOString(), sourceSha256: await sourceFingerprint(),
    suiteSha256: sha(await readFile(casesPath)), sourceVersion, config, budgetUsd, perRunBudgetUsd, timeoutMs: 180000, slots: schedule(cases),
    fixtureSha256: Object.fromEntries(cases.map(c => [c.id, sha(JSON.stringify(fixtureFiles(c)))])) };
}
export async function validatePlan(plan: FrozenPlan) {
  if (plan.schemaVersion !== 1 || plan.kind !== 'controlled-public-fixtures') throw new Error('Unsupported plan');
  const expected = await freezePlan(plan.config, plan.budgetUsd, plan.perRunBudgetUsd);
  for (const key of ['sourceSha256', 'suiteSha256', 'slots', 'fixtureSha256', 'timeoutMs'] as const)
    if (JSON.stringify(plan[key]) !== JSON.stringify(expected[key])) throw new Error(`Frozen plan changed: ${key}`);
}
/** No implicit write/batch approvals: only index.mjs edits and exactly npm test. */
export function reliabilityPermission(directory: string, description: string): boolean {
  try {
    const i = description.indexOf('\n'); if (i < 0) return false;
    const header = description.slice(0, i), metadata = JSON.parse(description.slice(i + 1));
    const permitted = (p: unknown) => typeof p === 'string' && [resolve(directory, p), resolve('/', p)].includes(join(directory, 'index.mjs'));
    if (header.startsWith('edit: ')) return header.slice(6).split(', ').every(permitted) && (metadata.filepath === undefined || permitted(metadata.filepath));
    return header === 'bash: npm test' && metadata.command === 'npm test' && (!metadata.workdir || resolve(metadata.workdir) === directory);
  } catch { return false; }
}
async function saveNew(path: string, data: unknown) { await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
export async function readFrozenPlan(bytes: Buffer, expectedSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha(bytes) !== expectedSha256) throw new Error('Plan SHA256 mismatch');
  const plan: FrozenPlan = JSON.parse(bytes.toString()); await validatePlan(plan); return plan;
}
function rehearsalBackend(c: ReliabilityCase, directory: string, slot: Slot): Backend {
  let calls = 0;
  return {
    catalog: async () => ['fast', 'balanced', 'deep'].map(t => ({ id: 'openrouter/smart-fixture-' + t, tools: true, context: 200000 })),
    create: async () => 'local-rehearsal', abort: async () => true, close: () => {},
    prompt: async (_id, _model, _prompt, stage) => {
      let validation: 'passed' | 'failed' | 'none' = 'none'; let evidence: string[] = [];
      if (stage === 'implement') await writeFile(join(directory, 'index.mjs'), c.reference + '\n');
      if (stage === 'implement' || stage === 'validate') {
        let exit = 0; try { await exec(process.execPath, ['--test', 'visible.test.mjs'], { cwd: directory, timeout: 5000 }); } catch { exit = 1; }
        evidence = validationEvidence([{ id: 'local-tool', sessionID: 'local-rehearsal', messageID: 'local-message', callID: 'local-call', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: '', title: 'Local fixture test', metadata: { exit }, time: { start: 0, end: 0 } } }]);
        validation = exit === 0 ? 'passed' : 'failed';
      }
      return { text: 'SIMULATION: scripted reference implementation, not model output.', usage: [{ messageId: slot.id + '-local-' + (++calls), inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'local' }], validation, evidence, reviewVerdict: stage === 'review' ? 'passed' : undefined };
    },
  };
}
async function runCampaign(planPath: string, output: string, expectedSha256: string, rehearsal: boolean) {
  const planBytes = await readFile(planPath); const plan = await readFrozenPlan(planBytes, expectedSha256);
  if (rehearsal && !Object.values(plan.config.models).every(m => /^openrouter\/smart-fixture-(?:fast|balanced|deep)$/.test(m))) throw new Error('Rehearsal requires the explicit smart-fixture model catalog');
  if (!rehearsal) { await loadLocalEnv(process.cwd()); if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY'); }
  // A campaign directory can never be reused. An interrupted attempt requires inspection, not replay.
  await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
  await saveNew(join(output, 'plan.json'), { sha256: sha(planBytes), plan });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smart-reliability-'))), previous = new Map<string, string | undefined>();
  const rows: ReliabilityRow[] = []; let stopReason = 'running';
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    previous.set(key, process.env[key]); process.env[key] = join(root, key.toLowerCase()); await mkdir(process.env[key]!);
  }
  const cases = await loadCases(); let meter: OpenRouterMeter | undefined;
  const report = async () => writeFile(join(output, 'summary.json'), JSON.stringify({ kind: plan.kind, execution: rehearsal ? 'SIMULATION' : 'PAID_MODELS', stopReason, sourceSha256: plan.sourceSha256, suiteSha256: plan.suiteSha256, results: rows, metrics: reliabilityMetrics(plan.slots, rows) }, null, 2) + '\n', { mode: 0o600 });
  try {
    if (!rehearsal) meter = await OpenRouterMeter.start(process.env.OPENROUTER_API_KEY!);
    for (const slot of plan.slots) {
      if (rows.some(r => r.unknownCost)) { stopReason = 'UNKNOWN_COST_INSPECT_PROVIDER'; break; }
      const spent = rows.reduce((n, r) => n + r.costUsd, 0);
      // Do not give the second arm a smaller budget. Stop before starting an underfunded slot.
      if (spent + plan.perRunBudgetUsd > plan.budgetUsd) { stopReason = 'CAMPAIGN_BUDGET'; break; }
      const c = cases.find(c => c.id === slot.caseId)!;
      const directory = join(root, slot.id); await mkdir(directory);
      const files = fixtureFiles(c); for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
      const started = Date.now(); await saveNew(join(output, `${slot.id}.started.json`), { ...slot, startedAt: new Date().toISOString(), fixtureSha256: plan.fixtureSha256[c.id] });
      let backend: Backend | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const row: ReliabilityRow = { ...slot, status: 'harness-error', accepted: false, preserved: false, costUsd: 0, unknownCost: true, durationMs: 0 };
      try {
        backend = rehearsal ? rehearsalBackend(c, directory, slot) : await OpenCodeBackend.start(directory, async d => { const allowed = reliabilityPermission(directory, d); if (!allowed) row.permissionDenials = (row.permissionDenials ?? 0) + 1; return allowed; }, { openrouterBaseURL: meter!.baseURL });
        const config = structuredClone(plan.config); config.mode = slot.arm === 'smart' ? 'auto' : 'manual'; config.limits.maxCostUsd = plan.perRunBudgetUsd;
        const controller = new Controller(rehearsal ? backend : meteredBackend(backend, meter!, () => {}), config, new Store(join(root, 'state')), () => {});
        if (slot.arm === 'deep-only') controller.preferredModel = () => 'deep';
        timer = setTimeout(() => { void controller.cancel().catch(() => false); }, plan.timeoutMs);
        const task = await controller.run(`Implement the following change: ${c.prompt}\nEdit only index.mjs using edit. Preserve all other files and existing user work. Run exactly npm test to validate. No other shell commands.`, directory);
        clearTimeout(timer);
        row.status = task.status; row.note = task.note; row.costUsd = task.spent; row.unknownCost = task.unknownCost;
        // Keep detailed operational evidence private; the public summary contains no transcripts/IDs/paths.
        await saveNew(join(output, `${slot.id}.task.json`), task);
        const candidatePath = join(directory, 'index.mjs');
        if ((await lstat(candidatePath)).isFile()) row.accepted = await evaluate(c, await readFile(candidatePath, 'utf8'));
        row.preserved = true;
        for (const [name, content] of Object.entries(files)) if (name !== 'index.mjs') {
          if (!(await lstat(join(directory, name))).isFile() || await readFile(join(directory, name), 'utf8') !== content) row.preserved = false;
        }
      } catch { row.status = 'harness-error'; row.note = 'HARNESS_ERROR_INSPECT_LOCAL_EVIDENCE'; }
      finally {
        if (timer) clearTimeout(timer);
        try { await backend?.close(); } catch { row.unknownCost = true; row.note = 'BACKEND_CLOSE_UNCERTAIN'; }
        row.durationMs = Date.now() - started;
        await saveNew(join(output, `${slot.id}.result.json`), row); rows.push(row); await report();
      }
      if (row.unknownCost) { stopReason = 'UNKNOWN_COST_INSPECT_PROVIDER'; break; }
      if (row.status === 'harness-error' || row.status === 'cancelled') { stopReason = 'INTERRUPTION_INSPECT_BEFORE_NEW_CAMPAIGN'; break; }
    }
    if (stopReason === 'running') stopReason = 'finished';
  } finally {
    meter?.close(); for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await report(); console.log(JSON.stringify({ execution: rehearsal ? 'SIMULATION' : 'PAID_MODELS', stopReason, attempted: rows.length, pending: plan.slots.length - rows.length, report: join(output, 'summary.json') }));
  }
}
async function main() {
  const args = process.argv.slice(2), allowed = new Set(['--verify-fixtures', '--freeze', '--run', '--config', '--budget', '--per-run-budget', '--output', '--plan', '--allow-fixture-tools', '--plan-sha256', '--rehearse']);
  for (const arg of args.filter(a => a.startsWith('--'))) if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
  const value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`Missing ${flag}`); return args[i + 1]!; };
  if (args.filter(a => ['--verify-fixtures', '--freeze', '--run', '--rehearse'].includes(a)).length > 1) throw new Error('Select one action');
  if (args.includes('--verify-fixtures')) { console.log(JSON.stringify(await verifyFixtures(), null, 2)); return; }
  if (args.includes('--freeze')) {
    const config = validateConfig(JSON.parse(await readFile(resolve(value('--config')), 'utf8')));
    const plan = await freezePlan(config, Number(value('--budget')), Number(value('--per-run-budget')));
    const output = resolve(value('--output')); await mkdir(dirname(output), { recursive: true }); await saveNew(output, plan);
    console.log(JSON.stringify({ status: 'FROZEN_NOT_RUN', slots: plan.slots.length, sourceSha256: plan.sourceSha256, planSha256: sha(await readFile(output)), output })); return;
  }
  if (args.includes('--run') || args.includes('--rehearse')) {
    if (args.includes('--run') && !args.includes('--allow-fixture-tools')) throw new Error('Paid runs require --allow-fixture-tools; generated code executes locally. Use a disposable environment.');
    await runCampaign(resolve(value('--plan')), resolve(value('--output')), value('--plan-sha256'), args.includes('--rehearse')); return;
  }
  const cases = await loadCases(); console.log(JSON.stringify({ status: 'NOT_RUN', kind: 'controlled-public-fixtures', inferenceRequests: 0, suiteSha256: sha(await readFile(casesPath)),
    projects: [...new Set(cases.map(c => c.project))], cases: cases.map(({ id, project, prompt }) => ({ id, project, prompt })), slots: schedule(cases),
    note: '10 tasks, 3 fixture projects, 3 repetitions, 2 arms. Public reference solutions: not a blind holdout. Freeze explicit models/configuration/budgets before a separately authorized paid run.' }, null, 2));
}
if (process.argv[1] && /reliability\.(?:ts|js)$/.test(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
