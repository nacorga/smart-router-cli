import { isMain } from './entrypoint.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireConfigured } from './config.js';
import { CodexBackend, ClaudeBackend } from './native-backends.js';
import { ContinuityController } from './continuity.js';
import { Store } from './state.js';
import { ContinuityStore } from './continuity-state.js';
import type { Backend, Destination, PortableTask } from './types.js';
const exec = promisify(execFile);
export const lifecycleCases = ['recovery', 'cancel-command', 'deny'] as const;
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) { console.log(JSON.stringify({ status: 'NOT_RUN', cases: lifecycleCases, backends: ['codex', 'claude'], realProviderInferenceRequests: 0, requirements: ['--run', '--allow-subscription-usage', '--config FILE', '--output NEW_PRIVATE_DIRECTORY'], note: 'Fixture-only POSIX controlling TTY. No inference without explicit authorization.' })); return; }
  if (!args.includes('--allow-subscription-usage')) throw new Error('Explicit subscription authorization required');
  const value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Missing ' + flag); return args[i + 1]!; };
  const backendFilter = args.includes('--backend') ? value('--backend') : undefined;
  if (backendFilter && !['codex', 'claude'].includes(backendFilter)) throw new Error('Invalid backend');
  const selectedCases = args.includes('--case') ? [value('--case')] : [...lifecycleCases];
  if (selectedCases.some(c => !lifecycleCases.includes(c as typeof lifecycleCases[number]))) throw new Error('Invalid lifecycle case');
  const config = await loadConfig(process.cwd(), resolve(value('--config'))); requireConfigured(config);
  if (!config.destinations || config.destinations.length !== 2 || !['codex', 'claude'].every(b => config.destinations!.some(d => d.backend === b && d.billing === 'subscription'))) throw new Error('Two subscription destinations required');
  if (process.platform === 'win32') throw new Error('POSIX TTY required');
  const requested = resolve(value('--output')), output = join(await realpath(dirname(requested)), basename(requested));
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url))), rel = relative(repository, output);
  if (!(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) throw new Error('Output must be outside repository');
  await exec('python3', ['--version']);
  await mkdir(output, { mode: 0o700 });
  const make = (d: Destination, project: string, approve: (description: string) => Promise<boolean>): Backend => d.backend === 'codex' ? new CodexBackend(d, project, approve) : new ClaudeBackend(d, project, approve);
  const destinations = config.destinations.filter(d => !backendFilter || d.backend === backendFilter);
  for (const d of destinations) {
    const b = make(d, output, async () => false);
    try { const p = await b.probe!(); if (!p.authenticated || !p.policyEnforced || p.availability.state === 'exhausted') throw new Error('NATIVE_PREFLIGHT_BLOCKED'); } finally { await b.close(); }
  }
  const rows: Record<string, unknown>[] = [];
  cases: for (const d of destinations) for (const kind of selectedCases) {
    const root = await mkdtemp(join(output, 'fixture-')), project = join(root, 'project'), state = join(root, 'state'), marker = join(root, 'command-started.json'); await mkdir(project, { mode: 0o700 });
    const initial = 'export const sum = (a, b) => a - b;\n', user = 'Existing user changes must survive.\n';
    await writeFile(join(project, 'sum.mjs'), initial); await writeFile(join(project, 'user.txt'), 'Committed user baseline.\n');
    await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
    const check = kind === 'cancel-command' ? `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);\n` : "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5); assert.equal(sum(-2,2),0);\n";
    await writeFile(join(project, 'check.mjs'), check);
    await exec('git', ['init', '-q', project]); await exec('git', ['-C', project, 'add', '.']);
    await exec('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-qm', 'Lifecycle pilot fixture']);
    await writeFile(join(project, 'user.txt'), user);
    // Keep the alternative configured to prove that denial/cancellation cannot trigger failover.
    const ordered = [d, ...config.destinations.filter(other => other.id !== d.id)];
    const local = { ...config, destinations: ordered, limits: { ...config.limits, maxCostUsd: 0, maxModelCalls: Math.min(config.limits.maxModelCalls, 16) } };
    const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(local), { mode: 0o600, flag: 'wx' });
    const objective = kind === 'cancel-command' ? 'Implement the validation step by running npm test exactly once. Do not edit any files. The harness will cancel the long-running test.' : 'Fix sum.mjs to add numbers correctly. Preserve user.txt and check.mjs. Run npm test as an exact direct command.';
    let before: PortableTask | undefined;
    if (kind === 'recovery') {
      let calls = 0; const firstConfig = structuredClone(local);
      const controller = new ContinuityController(async dest => {
        if (dest.id !== d.id) throw new Error('UNEXPECTED_FAILOVER');
        const b = make(dest, project, async description => { try { const metadata = JSON.parse(description.slice(description.indexOf('\n') + 1)); return description.startsWith('edit: ') && metadata.filepath === join(project, 'sum.mjs') || description.startsWith('bash: npm test\n') && metadata.command === 'npm test' && metadata.workdir === project; } catch { return false; } });
        const prompt = b.prompt.bind(b);
        b.prompt = async (...input) => { if (++calls > 3) throw new Error('PILOT_REQUEST_LIMIT'); const r = await prompt(...input); if (input[3] === 'implement' && !r.failure && r.validation === 'passed') firstConfig.limits.maxModelCalls = 0; return r; };
        return b;
      }, firstConfig, new Store(state), () => {});
      before = await controller.run(objective, project);
      if (before.requestState !== 'idle' || before.note !== 'BUDGET_OR_CALL_LIMIT' || before.stages.filter(s => s.status === 'done').length !== 2) { rows.push({ backend: d.backend, case: kind, status: 'blocked', note: before.note, wrapperRequests: before.calls }); break cases; }
    }
    const beforeFingerprint = before ? (await new ContinuityStore(new Store(state)).get(before.id)).fingerprint : undefined;
    const control = { project, state, mode: kind === 'recovery' ? 'continue' : kind, node: process.execPath, cli: fileURLToPath(new URL('./cli.js', import.meta.url)), config: configPath, taskId: before?.id, commandMarker: marker, transcript: join(root, 'tty.txt'), objective };
    const controlPath = join(root, 'control.json'); await writeFile(controlPath, JSON.stringify(control), { mode: 0o600, flag: 'wx' });
    let tty: any;
    try { tty = JSON.parse((await exec('python3', [fileURLToPath(new URL('../scripts/continuity-tty.py', import.meta.url)), controlPath], { timeout: 200000, maxBuffer: 1024 * 1024 })).stdout); }
    catch { rows.push({ backend: d.backend, case: kind, status: 'blocked', note: 'TTY_INSPECTION_REQUIRED', root }); break cases; }
    const tasks = await new Store(state).list(project), task = tasks[0] as PortableTask | undefined;
    const preserved = await readFile(join(project, 'user.txt'), 'utf8') === user && await readFile(join(project, 'check.mjs'), 'utf8') === check;
    const sameDestination = task?.activeDestination === d.id && task.transitions.length === 1;
    let accepted = false, commandExited: boolean | undefined, noReplay: boolean | undefined;
    if (kind === 'recovery' && task && before) {
      let verified = false; try { await exec(process.execPath, ['check.mjs'], { cwd: project, timeout: 5000 }); verified = true; } catch { /* Retain failure. */ }
      const fingerprintPreserved = (await new ContinuityStore(new Store(state)).get(task.id)).fingerprint === beforeFingerprint;
      accepted = fingerprintPreserved && task.spent === before.spent && task.budget === before.budget && task.usage.length >= before.usage.length && tty.exitCode === 0 && task.status === 'completed' && task.calls === before.calls + 1 && task.sessions[d.id] === before.sessions[d.id] && JSON.stringify(task.stageCounters) === JSON.stringify(before.stageCounters) && sameDestination && preserved && verified;
    } else if (kind === 'cancel-command' && task) {
      try { const pid = JSON.parse(await readFile(marker, 'utf8')).pid; if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid command identity'); const stat = (await exec('ps', ['-o', 'stat=', '-p', String(pid)])).stdout.trim(); commandExited = !stat || stat.startsWith('Z'); } catch (error) { commandExited = (error as { code?: unknown }).code === 1; }
      const prior = task.calls;
      try { await exec(process.execPath, [control.cli, '--config', configPath, '--continue', task.id], { cwd: project, env: { ...process.env, SMART_STATE_DIR: state }, timeout: 15000 }); noReplay = false; }
      catch (error) { noReplay = (error as { code?: unknown }).code === 1 && String((error as { stderr?: string }).stderr).includes('INSPECTION_REQUIRED_NO_REPLAY') && (await new Store(state).get(task.id)).calls === prior; }
      accepted = tty.exitCode !== 0 && tty.signalled && task.status === 'cancelled' && task.requestState === 'uncertain' && commandExited === true && noReplay === true && sameDestination && preserved && await readFile(join(project, 'sum.mjs'), 'utf8') === initial;
    } else if (kind === 'deny' && task) accepted = tty.exitCode !== 0 && tty.denials > 0 && tty.approvals === 0 && task.status === 'blocked' && task.note === 'PERMISSION_DENIED' && sameDestination && preserved && await readFile(join(project, 'sum.mjs'), 'utf8') === initial;
    const row = { backend: d.backend, case: kind, status: accepted ? 'passed' : 'blocked', taskStatus: task?.status, note: task?.note, wrapperRequests: task?.calls, tty, preserved, sameDestination, commandExited, noReplay, root };
    rows.push(row); await writeFile(join(root, 'result.json'), JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 });
    if (!accepted) break cases;
  }
  const report = { status: rows.length === destinations.length * selectedCases.length && rows.every(r => r.status === 'passed') ? 'PASSED' : 'INCOMPLETE', rows, realProviderInferenceRequests: rows.some(r => Number(r.wrapperRequests) > 0) ? null : 0, subscriptionMonetaryCost: null };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify(report)); if (report.status !== 'PASSED') process.exitCode = 1;
}
if (isMain(import.meta.url)) void main().catch(() => { console.error('Lifecycle pilot refused or failed; inspect the private output directory.'); process.exitCode = 1; });
