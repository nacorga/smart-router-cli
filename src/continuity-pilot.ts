import { isMain } from './entrypoint.js';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireConfigured } from './config.js';
import { ContinuityController } from './continuity.js';
import { ClaudeBackend, CodexBackend } from './native-backends.js';
import { Store } from './state.js';
import type { Backend, Destination } from './types.js';
const exec = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) { console.log(JSON.stringify({ status: 'NOT_RUN', realProviderInferenceRequests: 0, scenarios: ['codex-only', 'claude-only', 'forced-stage-boundary-handoff'], requirements: ['--run', '--allow-subscription-usage', '--config FILE', '--output NEW_DIRECTORY_OUTSIDE_REPOSITORY'], note: 'No inference without explicit subscription authorization. All native policy preflights must pass before the first request.' })); return; }
  const value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Missing ' + flag); return args[i + 1]!; };
  if (!args.includes('--allow-subscription-usage')) throw new Error('Explicit subscription usage authorization required');
  const scenarios = args.includes('--scenario') ? [value('--scenario')] : ['codex-only', 'claude-only', 'forced-stage-boundary-handoff'];
  if (scenarios.some(s => !['codex-only', 'claude-only', 'forced-stage-boundary-handoff'].includes(s))) throw new Error('Unknown pilot scenario');
  const requestedOutput = resolve(value('--output'));
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput)), repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const outputRelative = relative(repository, output);
  if (!(outputRelative === '..' || outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative))) throw new Error('Pilot output must be outside the repository');
  const config = await loadConfig(process.cwd(), resolve(value('--config'))); requireConfigured(config);
  if (!config.destinations || config.destinations.length !== 2 || !['codex', 'claude'].every(name => config.destinations!.some(d => d.backend === name && d.billing === 'subscription'))) throw new Error('Pilot requires exactly Codex and Claude subscription destinations');
  await mkdir(output, { mode: 0o700 });
  const make = (d: Destination, directory: string, approve: (description: string) => Promise<boolean>): Backend => d.backend === 'codex' ? new CodexBackend(d, directory, approve) : new ClaudeBackend(d, directory, approve);
  const preflight = [];
  for (const d of config.destinations) {
    const b = make(d, output, async () => false);
    try { preflight.push({ destination: d.id, ...await b.probe!() }); } finally { await b.close(); }
  }
  if (preflight.some(p => !p.authenticated || !p.policyEnforced)) {
    const report = { status: 'BLOCKED_PREFLIGHT', realProviderInferenceRequests: 0, preflight };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }); console.log(JSON.stringify(report)); process.exitCode = 1; return;
  }
  const rows: { scenario: string; status: string; note?: string; wrapperRequests: number; independentlyAccepted: boolean; transitions: number }[] = [];
  for (const scenario of scenarios) {
    if (scenario === 'forced-stage-boundary-handoff' && rows.some(row => row.status !== 'completed' || !row.independentlyAccepted)) {
      rows.push({ scenario, status: 'blocked', note: 'SINGLE_BACKEND_PREREQUISITE_FAILED', wrapperRequests: 0, independentlyAccepted: false, transitions: 0 }); continue;
    }
    const root = await mkdtemp(join(output, 'fixture-')), project = join(root, 'project'); await mkdir(project);
    await writeFile(join(project, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
    await writeFile(join(project, 'user.txt'), 'existing user work');
    await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
    await writeFile(join(project, 'check.mjs'), "import { sum } from './sum.mjs'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(sum(2, 3), 5); assert.equal(sum(-2, 2), 0); assert.equal(readFileSync('user.txt', 'utf8'), 'existing user work');");
    await exec('git', ['init', '-q', project]); await exec('git', ['-C', project, 'add', '.']);
    await exec('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-qm', 'Isolated pilot fixture']);
    const selected = scenario === 'codex-only' ? config.destinations.filter(d => d.backend === 'codex') : scenario === 'claude-only' ? config.destinations.filter(d => d.backend === 'claude') : config.destinations;
    let prompts = 0;
    const c = new ContinuityController(async d => {
      const approve = async (description: string) => {
        try { const first = description.indexOf('\n'), metadata = JSON.parse(description.slice(first + 1));
          return description.startsWith('edit: ') && metadata.filepath === join(project, 'sum.mjs') || description.startsWith('bash: npm test\n') && metadata.command === 'npm test' && metadata.workdir === project;
        } catch { return false; }
      };
      const b = make(d, project, approve); const nativePrompt = b.prompt.bind(b), availability = b.availability?.bind(b);
      let successfulPrompts = 0;
      b.prompt = async (...args) => { if (prompts >= 4) return { text: '', usage: [], validation: 'none', evidence: [], failure: 'limit', toolsExecuted: false }; prompts++; const result = await nativePrompt(...args); if (!result.failure) successfulPrompts++; return result; };
      if (scenario === 'forced-stage-boundary-handoff' && d.id === selected[0]!.id) b.availability = async () => successfulPrompts ? { state: 'exhausted', source: 'pilot-forced-boundary-not-real-quota', observedAt: new Date().toISOString() } : availability!();
      return b;
    }, { ...config, destinations: selected, limits: { ...config.limits, maxCostUsd: 0, maxModelCalls: Math.min(config.limits.maxModelCalls, 16) } }, new Store(join(root, 'state')), () => {});
    const task = await c.run('Fix sum.mjs to add numbers correctly. Preserve user.txt and tests. Run npm test as an exact direct command.', project);
    let independentlyAccepted = false;
    try { await exec(process.execPath, ['check.mjs'], { cwd: project, timeout: 10000 }); independentlyAccepted = true; } catch { /* Failed checks remain visible. */ }
    rows.push({ scenario, status: task.status, note: task.note, wrapperRequests: prompts, independentlyAccepted: independentlyAccepted && (scenario !== 'forced-stage-boundary-handoff' || task.transitions.length === 2 && task.transitions[0]?.to === selected[0]!.id && task.transitions[1]?.to === selected[1]!.id), transitions: task.transitions.length });
  }
  const report = { status: rows.every(r => r.status === 'completed' && r.independentlyAccepted) ? 'PASSED' : 'INCOMPLETE', rows, wrapperRequests: rows.reduce((n, r) => n + r.wrapperRequests, 0), realProviderInferenceRequests: rows.some(r => r.wrapperRequests > 0) ? null : 0 };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }); console.log(JSON.stringify(report));
  if (report.status !== 'PASSED') process.exitCode = 1;
}
if (isMain(import.meta.url)) void main().catch(() => { console.error('Pilot refused or failed; inspect the private output directory.'); process.exitCode = 1; });
