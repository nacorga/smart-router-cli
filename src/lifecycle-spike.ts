import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, requireConfigured } from './config.js';
import { loadLocalEnv } from './env.js';
import { OpenCodeBackend } from './opencode.js';
import { Controller } from './controller.js';
import { Store, lockProject } from './state.js';
import type { Config, Model, Task } from './types.js';

async function exists(path: string) { try { await readFile(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
export function interruptedReservation(task: Task, catalog: Model[]) {
  const items = task.usage.filter(u => u.costUsd === undefined).map(u => {
    const model = catalog.find(m => m.id === u.modelId);
    if (!model || model.inputPrice === undefined || model.outputPrice === undefined || !model.outputLimit) throw new Error('NO_CATALOG_LIMITS_FOR_INTERRUPTED_CALL');
    const reservedCostUsd = (model.context * model.inputPrice + model.outputLimit * model.outputPrice) / 1e6;
    if (!Number.isFinite(reservedCostUsd) || reservedCostUsd <= 0) throw new Error('INVALID_INTERRUPTED_CALL_RESERVATION');
    return { messageId: u.messageId, modelId: model.id, maxInputTokens: model.context, maxOutputTokens: model.outputLimit, inputPrice: model.inputPrice, outputPrice: model.outputPrice, reservedCostUsd };
  });
  if (task.unknownCost && !items.length) throw new Error('NO_IDENTIFIABLE_INTERRUPTED_CALL');
  return { source: 'catalog-max-token-reservation', reservedCostUsd: items.reduce((n, i) => n + i.reservedCostUsd, 0), items, note: 'Budget reservation at catalog tariffs, not actual spend or a provider hard cap. Missing usage remains unknown.' };
}
async function resumeExisting(router: string, config: Config) {
  const path = resolve(router, 'artifacts/LIFECYCLE-RESULT.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  const project: string = report.projectPath;
  const cancelled = (report.tasks as Task[]).findLast(t => t.status === 'cancelled');
  assert.ok(cancelled?.sessionId); assert.equal(report.abortConfirmed, true); assert.equal(report.validationProcessStopped, true);
  for (const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']) process.env[name] = join(project, name.toLowerCase());
  process.chdir(project);
  const backend = await OpenCodeBackend.start(project, async () => false);
  report.status = 'running';
  try {
    const query = { directory: project, sessionID: cancelled.sessionId };
    const { data: before } = await backend.client.session.messages(query, { throwOnError: true });
    const mutationIds = before.flatMap(m => m.parts).filter(p => p.type === 'tool' && ['edit','write','apply_patch','bash'].includes(p.tool)).map(p => p.id);
    const reservation = interruptedReservation(cancelled, await backend.catalog());
    report.interruptedCostReservation = reservation;
    config.limits.maxCostUsd = report.budgetUsd - Number(report.previousCostUsd ?? 0) - (report.tasks as Task[]).reduce((n,t) => n+t.spent,0) - reservation.reservedCostUsd;
    assert.ok(config.limits.maxCostUsd > 0, 'INSUFFICIENT_BUDGET_AFTER_RESERVATION');
    const controller = new Controller(backend, config, new Store(join(project, 'smart-state')), s => { if (/^\[(?:FAST|BALANCED|DEEP)\]|^Result:/.test(s)) console.log(s); });
    await controller.resume(cancelled.id, project);
    const { data: restored } = await backend.client.session.messages(query, { throwOnError: true });
    assert.deepEqual(restored.map(m => m.info.id), before.map(m => m.info.id));
    report.checkpointRecoveredAfterServerRestart = true; report.resumeWithoutReplay = true;
    const continued = await bounded(controller.run('Explica el valor actual de counter.txt y confirma que original.txt conserva su texto. Lee ambos archivos; consulta de solo lectura. No ejecutes comandos ni vuelvas a editar ningún archivo.', project), 60000);
    report.tasks.push(continued);
    assert.equal(continued.sessionId, cancelled.sessionId); assert.equal(continued.status, 'completed');
    const { data: after } = await backend.client.session.messages(query, { throwOnError: true });
    assert.deepEqual(after.flatMap(m => m.parts).filter(p => p.type === 'tool' && ['edit','write','apply_patch','bash'].includes(p.tool)).map(p => p.id), mutationIds);
    assert.equal((await readFile(join(project,'counter.txt'),'utf8')).trim(),'1');
    assert.equal(await readFile(join(project,'original.txt'),'utf8'),'PRESERVE_EXISTING_CONTENT\n');
    assert.equal(await readFile(join(project,'validation-started'),'utf8'),'x');
    report.sameNativeSession = true; report.previousEffectsPreserved = true; report.validationInvocations = 1; report.status = 'passed'; delete report.failure;
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
    throw error;
  } finally {
    await backend.close(); process.chdir(router);
    report.reportedCostUsd = Number(report.previousCostUsd ?? 0) + (report.tasks as Task[]).reduce((n,t) => n+t.spent,0);
    report.unknownCost = (report.tasks as Task[]).some(t => t.unknownCost);
    delete report.totalCostUsd;
    await writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({status:report.status,reportedCostUsd:report.reportedCostUsd,unknownCost:report.unknownCost,reservedUnknownCostUsd:report.interruptedCostReservation?.reservedCostUsd}));
  }
}
async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Paid cancellation/resume test in a temporary project. Use --run; respects the configured budget and does not modify existing repositories.');
    return;
  }
  const router = process.cwd();
  const config = await loadConfig(router); requireConfigured(config); await loadLocalEnv(router);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');
  if (process.argv.includes('--resume-existing')) { await resumeExisting(router, config); return; }
  const project = await realpath(await mkdtemp(join(tmpdir(), 'smart-lifecycle-')));
  await mkdir(join(router,'artifacts'),{recursive:true});
  const reportPath = resolve(router, 'artifacts/LIFECYCLE-RESULT.json');
  const store = new Store(join(project, 'smart-state'));
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(await readFile(reportPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const previousTasks = (previous.tasks ?? []) as Task[];
  if (previousTasks.some(task => task.unknownCost)) throw new Error('PREVIOUS_ATTEMPT_COST_UNKNOWN');
  const previousCostUsd = typeof previous.totalCostUsd === 'number' ? previous.totalCostUsd : Number(previous.previousCostUsd ?? 0) + previousTasks.reduce((n, task) => n + task.spent, 0);
  const totalBudgetUsd = config.limits.maxCostUsd;
  config.limits.maxCostUsd = Math.max(0, totalBudgetUsd - previousCostUsd);
  const report: Record<string, unknown> = { date: new Date().toISOString().slice(0,10), status: 'running', projectPath: project, budgetUsd: totalBudgetUsd, previousCostUsd, previousAttempt: previous.status ? { status: previous.status, failure: previous.failure, totalCostUsd: previousCostUsd } : undefined, models: config.models, tasks: [] };
  const save = async () => { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
  await writeFile(join(project, 'counter.txt'), '0\n');
  await writeFile(join(project, 'original.txt'), 'PRESERVE_EXISTING_CONTENT\n');
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
  await writeFile(join(project, 'check.mjs'), `import { appendFile, writeFile, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
await writeFile('validation-pid', String(process.pid));
await appendFile('validation-started', 'x');
console.log('VALIDATION_STARTED');
await setTimeout(30000);
if ((await readFile('counter.txt','utf8')).trim() !== '1') process.exitCode=1;
await writeFile('validation-finished','done');
`);
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const path = join(project, name.toLowerCase()); await mkdir(path); process.env[name] = path;
  }
  process.chdir(project);
  const permissions: { permission: string; approved: boolean }[] = [];
  const approve = async (description: string) => {
    const split = description.indexOf('\n');
    const header = description.slice(0, split);
    const metadata = JSON.parse(description.slice(split + 1));
    const allowedEdit = header.startsWith('edit: ') && header.slice(6).split(', ').every(p => resolve(project, p) === join(project, 'counter.txt') || resolve('/', p) === join(project, 'counter.txt'));
    const allowedCommand = header.startsWith('bash: ') && metadata.command === 'npm test';
    const approved = allowedEdit || allowedCommand;
    permissions.push({ permission: header, approved }); console.log(`${approved ? 'APPROVED' : 'REJECTED'} ${header}`);
    return approved;
  };
  const output = (s: string) => { if (/^\[(?:FAST|BALANCED|DEEP)\]|^Result:|^Abort /.test(s)) console.log(s); };
  let backend: OpenCodeBackend | undefined;
  let controller: Controller | undefined;
  let active: Promise<Task> | undefined;
  try {
    backend = await OpenCodeBackend.start(project, approve);
    controller = new Controller(backend, structuredClone(config), store, output);
    active = controller.run('Implementa un cambio mínimo: cambia counter.txt de 0 a 1 exactamente una vez. Conserva original.txt, package.json y check.mjs. Solo puedes editar counter.txt mediante edit. Explora con read y sin shell. En implementación, después de editar ejecuta exactamente npm test y espera el resultado. El test tarda 30 segundos por diseño: no lo modifiques ni lo omitas. No ejecutes otros comandos.', project);
    let ended = false; void active.finally(() => { ended = true; }).catch(() => {});
    const deadline = Date.now() + 90000;
    while (!await exists(join(project, 'validation-started'))) {
      if (ended) throw new Error('TASK_ENDED_BEFORE_CANCELLATION_POINT');
      if (Date.now() > deadline) throw new Error('VALIDATION_START_TIMEOUT');
      await delay(100);
    }
    assert.equal((await readFile(join(project, 'counter.txt'), 'utf8')).trim(), '1');
    const pid = Number(await readFile(join(project, 'validation-pid'), 'utf8'));
    const callsAtCancellation = controller.task!.calls;
    const started = Date.now();
    const confirmed = await bounded(controller.cancel(), 15000);
    const cancelled = await bounded(active, 15000); active = undefined;
    report.tasks = [cancelled]; report.abortConfirmed = confirmed; report.cancelLatencyMs = Date.now() - started;
    await save();
    assert.equal(confirmed, true); assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.calls, callsAtCancellation, 'No new stage after cancellation');
    for (let i = 0; i < 30 && alive(pid); i++) await delay(100);
    report.validationProcessStopped = !alive(pid);
    assert.equal(alive(pid), false, 'Validation subprocess survived abort');
    assert.equal(await exists(join(project, 'validation-finished')), false);
    const sessionID = cancelled.sessionId!;
    const { data: statuses } = await backend.client.session.status({ directory: project }, { throwOnError: true });
    assert.ok(!statuses[sessionID] || statuses[sessionID]?.type === 'idle');
    report.nativeSessionIdle = true;
    const { data: beforeRestart } = await backend.client.session.messages({ directory: project, sessionID }, { throwOnError: true });
    const mutationIds = beforeRestart.flatMap(m => m.parts).filter(p => p.type === 'tool' && ['edit','write','apply_patch','bash'].includes(p.tool)).map(p => p.id);
    const release = await lockProject(project, store.root); await release(); report.projectLockReleased = true;
    await backend.close(); backend = undefined;
    backend = await OpenCodeBackend.start(project, approve);
    const resumedConfig = structuredClone(config);
    const reservation = interruptedReservation(cancelled, await backend.catalog());
    report.interruptedCostReservation = reservation;
    resumedConfig.limits.maxCostUsd = Math.max(0, config.limits.maxCostUsd - cancelled.spent - reservation.reservedCostUsd);
    controller = new Controller(backend, resumedConfig, new Store(store.root), output);
    const recovered = await controller.resume(cancelled.id, project);
    assert.equal(recovered.status, 'cancelled');
    const { data: afterRestore } = await backend.client.session.messages({ directory: project, sessionID }, { throwOnError: true });
    assert.deepEqual(afterRestore.map(m => m.info.id), beforeRestart.map(m => m.info.id));
    report.checkpointRecoveredAfterServerRestart = true; report.resumeWithoutReplay = true;
    active = controller.run('Explica el valor actual de counter.txt y confirma que original.txt conserva su texto. Lee ambos archivos; consulta de solo lectura. No ejecutes comandos ni vuelvas a editar ningún archivo.', project);
    const continued = await bounded(active, 60000); active = undefined;
    report.tasks = [cancelled, continued]; report.totalCostUsd = previousCostUsd + cancelled.spent + continued.spent; report.unknownCost = cancelled.unknownCost || continued.unknownCost;
    await save();
    assert.equal(continued.sessionId, sessionID); assert.equal(continued.status, 'completed');
    const { data: afterContinue } = await backend.client.session.messages({ directory: project, sessionID }, { throwOnError: true });
    const afterMutationIds = afterContinue.flatMap(m => m.parts).filter(p => p.type === 'tool' && ['edit','write','apply_patch','bash'].includes(p.tool)).map(p => p.id);
    assert.deepEqual(afterMutationIds, mutationIds, 'Continuation repeated effective tools');
    assert.equal(await readFile(join(project, 'validation-started'), 'utf8'), 'x');
    assert.equal((await readFile(join(project, 'counter.txt'), 'utf8')).trim(), '1');
    assert.equal(await readFile(join(project, 'original.txt'), 'utf8'), 'PRESERVE_EXISTING_CONTENT\n');
    report.sameNativeSession = true; report.previousEffectsPreserved = true; report.validationInvocations = 1;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
    throw error;
  } finally {
    if (active && controller) { if (controller.task?.status === 'running') await controller.cancel().catch(() => false); const task = await bounded(active, 15000).catch(() => undefined); if (task) report.tasks = [task]; }
    await backend?.close(); process.chdir(router);
    const tasks = (report.tasks ?? []) as Task[];
    report.totalCostUsd = previousCostUsd + tasks.reduce((n, task) => n + task.spent, 0);
    report.unknownCost = tasks.some(task => task.unknownCost);
    if (report.unknownCost) { report.reportedCostUsd = report.totalCostUsd; delete report.totalCostUsd; }
    report.permissions = permissions; await save();
    console.log(JSON.stringify({ status: report.status, reportPath, fixture: project, totalCostUsd: report.totalCostUsd, unknownCost: report.unknownCost }));
  }
}
if (process.argv[1] && /lifecycle-spike\.(?:ts|js)$/.test(process.argv[1])) main().catch(error => { console.error(error instanceof Error ? error.message : 'Lifecycle test failed'); process.exitCode = 1; });
