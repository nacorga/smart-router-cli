#!/usr/bin/env node
import { isMain } from './entrypoint.js';
import { loadLocalEnv } from './env.js';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaults, loadConfig, requireConfigured, subscriptionTemplate } from './config.js';
import { Store, projectRoot } from './state.js';
import { OpenCodeBackend } from './opencode.js';
import { DemoBackend } from './demo.js';
import { ContinuityController } from './continuity.js';
import { ContinuityStore, coordination } from './continuity-state.js';
import { createBackend } from './engine/backend-factory.js';
import type { Destination, PortableTask } from './types.js';
import { Controller } from './controller.js';
import type { Backend, Config, Task } from './types.js';
const help = `smart "task" [--config file] [--demo] [--deep-only]
smart                 Interactive mode
smart --init [--subscriptions]  Write configuration with model placeholders
smart --backends      Diagnose configured backends without inference
smart --handoff <id>  Inspect private continuation context
smart --continue <id> Continue from a confirmed checkpoint
smart --coordination <id>  Print sanitized Markdown coordination
smart --sessions      List project tasks
smart --resume [id]   Load metadata without replaying actions
smart --export [id]   Export a summary without prompt contents
smart --plan "task"   Preview routing without provider requests
Commands: /mode auto|manual, /model fast|balanced|deep|provider/id,
/budget USD, /status, /history, /sessions, /resume [id], /cancel, /help, /exit
Permissions: reply "yes" only for the displayed operation. Ctrl-C cancels.`;
function availabilityStatus(task: PortableTask) {
  return Object.fromEntries(Object.entries(task.availability).map(([id, value]) => [id, { ...value, ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(value.observedAt)) / 1000)) }]));
}
export function summary(task: Task) {
  return { ...((task as PortableTask).schemaVersion === 2 ? { schemaVersion: 2, activeDestination: (task as PortableTask).activeDestination, availability: availabilityStatus(task as PortableTask), transitions: (task as PortableTask).transitions, requestState: (task as PortableTask).requestState } : {}), id: task.id, project:task.project, status: task.status, mode:task.mode, override:task.override, budget:task.budget, remainingBudgetUsd:task.unknownCost?null:Math.max(0,task.budget-task.spent), spent: task.spent, unknownCost: task.unknownCost, calls: task.calls, stages: task.stages, usage: task.usage, note: task.note, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`); args.splice(i, 2); return value; };
  const configPath = take('--config');
  const flag = (f: string) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  if (flag('--help') || flag('-h')) { console.log(help); return; }
  if (flag('--init')) { const path = resolve('smart-router.config.json'); const subscriptions = flag('--subscriptions'); await writeFile(path, JSON.stringify(subscriptions ? subscriptionTemplate() : defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(subscriptions ? `Configure ${path}: explicit native model IDs for Codex and Claude. Subscription sign-in required.` : `Configure ${path}. Models: provider/vendor/model-id; key: OPENROUTER_API_KEY.`); return; }
  const project = await projectRoot(process.cwd()); const store = new Store();
  if (flag('--sessions')) { console.log((await store.list(project)).map(t => `${t.id} ${t.status} ${t.updatedAt}`).join('\n')); return; }
  const inspectHandoff = take('--handoff'), markdown = take('--coordination');
  if (inspectHandoff || markdown) {
    const id = inspectHandoff ?? markdown!; const task = await store.get(id);
    if (task.projectPath !== project || (task as PortableTask).schemaVersion !== 2) throw new Error('Portable task not found in project');
    console.log(inspectHandoff ? JSON.stringify(await new ContinuityStore(store).get(id), null, 2) : coordination(task as PortableTask)); return;
  }
  const continuing = take('--continue'), diagnosing = flag('--backends');
  const resume = flag('--resume'), exporting = flag('--export');
  if (resume || exporting) {
    const task = args[0] ? await store.get(args[0]) : (await store.list(project))[0];
    if (!task || task.projectPath !== project) throw new Error('Session not found in this project');
    console.log(JSON.stringify(exporting ? summary(task) : task, null, 2));
    if (resume) console.log('Loaded for inspection. Tools are not replayed automatically.'); return;
  }
  const demo = flag('--demo'), deepOnly = flag('--deep-only'), planOnly = flag('--plan');
  if (args.some(a => a.startsWith('--'))) throw new Error('Unknown option; see --help');
  const config: Config = await loadConfig(project, configPath);
  if (demo) { delete config.destinations; config.models = { fast: 'demo/fast', balanced: 'demo/balanced', deep: 'demo/deep' }; console.log('OFFLINE DEMO: no edits, no real costs, no provider validation.'); }
  if (deepOnly) config.mode = 'manual';
  const { classify, plan, routeTarget } = await import('./router.js');
  if (planOnly) {
    const c = classify(args.join(' '));
    const override = deepOnly ? 'deep' : config.mode === 'manual' ? 'balanced' : undefined;
    console.log(JSON.stringify({ classification:c, availabilityChecked:false, stages:plan(c).map(s => config.destinations ? { kind: s.kind, candidates: config.destinations.map(d => ({ destination: d.id, backend: d.backend, billing: d.billing, ...routeTarget(s, c, { ...config, models: d.models }, override) })) } : ({kind:s.kind,...routeTarget(s,c,config,override)})) },null,2)); return;
  }
  const makeBackend = (d: Destination, approve: (description: string) => Promise<boolean>) => createBackend(d, project, approve);
  if (diagnosing) {
    const results = [];
    for (const d of config.destinations ?? [{ id: 'opencode', backend: 'opencode' as const, billing: 'api' as const, models: config.models }]) {
      let native: Backend | undefined;
      try {
        if (d.backend === 'opencode') { results.push({ destination: d.id, backend: d.backend, billing: d.billing, reason: 'API_ROUTE_CONFIGURED_NO_INFERENCE', availability: { state: 'unknown', source: 'configuration-only', observedAt: new Date().toISOString() } }); continue; }
        native = await makeBackend(d, async () => false); const probe = await native.probe?.(); results.push({ destination: d.id, backend: d.backend, billing: d.billing, ...probe, quota: probe?.authenticated ? await native.availability?.() : undefined });
      } catch { results.push({ destination: d.id, reason: 'PREFLIGHT_UNAVAILABLE' }); }
      finally { await native?.close(); }
    }
    console.log(JSON.stringify(results, null, 2)); return;
  }
  if (continuing && !config.destinations) throw new Error('--continue requires version 2 destinations');
  if (!demo && !config.destinations) await loadLocalEnv(project);
  requireConfigured(config);
  if (!demo && !config.destinations && !process.env.OPENROUTER_API_KEY && config.provider === 'openrouter') throw new Error('Missing OPENROUTER_API_KEY; use --demo or configure the key locally.');
  console.log(`Project: ${project}\nBackend: ${config.destinations ? 'Sequential destination chain' : 'OpenCode SDK/server 1.19.3'} · provider: ${demo ? 'demo' : config.provider} · budget $${config.limits.maxCostUsd}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let approval: ((b: boolean) => void) | undefined;
  const approve = async (description: string) => {
    if (!process.stdin.isTTY) { console.log(`Permission denied in non-interactive mode: ${description}`); return false; }
    if (approval) return false;
    console.log(`Approve ONE operation: ${description}\nReply yes/no:`);
    return new Promise<boolean>(r => { approval = r; });
  };
  let backend: Backend | undefined; let active: Promise<Task> | undefined; let controller: Controller | ContinuityController | undefined;
  let chosen: string | undefined = deepOnly ? 'deep' : config.mode === 'manual' ? 'balanced' : undefined;
  const run = (request: string) => {
    if (!controller || active) { console.log('A task is active. Use /cancel or wait.'); return; }
    active = controller.run(request, project).then(t => { if (!demo && ['failed', 'blocked', 'cancelled'].includes(t.status)) process.exitCode = 1; return t; }).catch(error => { console.error(error instanceof Error ? error.message : 'Task error'); process.exitCode = 1; return controller!.task!; }).finally(() => { active = undefined; if (!args.length) console.log('smart>'); });
  };
  try {
    if (config.destinations) controller = new ContinuityController(d => makeBackend(d, approve), config, store);
    else { backend = demo ? new DemoBackend() : await OpenCodeBackend.start(project, approve); controller = new Controller(backend, config, store); }
    controller.preferredModel = () => chosen;
    const command = async (line: string) => {
      const [cmd, ...rest] = line.trim().split(/\s+/); const value = rest.join(' ');
      if (!cmd) return;
      if (cmd === '/cancel') { approval?.(false); approval = undefined; await controller!.cancel(); }
      else if (cmd === '/mode') { if (!['auto', 'manual'].includes(value)) throw new Error('Use /mode auto|manual'); config.mode = value as Config['mode']; chosen = value === 'auto' ? undefined : chosen ?? 'balanced'; if (controller!.task) controller!.task.mode = config.mode; }
      else if (cmd === '/model') { if (!value) throw new Error('Specify a tier or provider/model'); chosen = value; config.mode = 'manual'; console.log(`Override: ${chosen}`); }
      else if (cmd === '/budget') { const n = Number(value); if (!value || !Number.isFinite(n) || n < 0) throw new Error('Invalid budget'); config.limits.maxCostUsd = n; if (controller!.task) controller!.task.budget = n; }
      else if (cmd === '/status') console.log(controller!.task ? JSON.stringify(summary(controller!.task), null, 2) : 'No task');
      else if (cmd === '/history') console.log(JSON.stringify(controller instanceof ContinuityController ? { backend: controller.task?.activeDestination, availability: controller.task ? availabilityStatus(controller.task) : {}, decisions: controller.task?.stages.flatMap(s => s.decisions) ?? [], transitions: controller.task?.transitions ?? [] } : controller!.task?.stages.flatMap(s => s.decisions) ?? [], null, 2));
      else if (cmd === '/sessions') console.log((await store.list(project)).map(t => `${t.id} ${t.status}`).join('\n'));
      else if (cmd === '/resume') { if (active) throw new Error('Cancel the active task first'); const t = await controller!.resume(value || undefined, project); config.mode = t.mode; chosen = t.override; config.limits.maxCostUsd = t.budget; }
      else if (cmd === '/help') console.log(help);
      else if (cmd === '/exit') { if (active) await controller!.cancel(); rl.close(); }
      else if (cmd.startsWith('/')) throw new Error('Unknown command; use /help');
      else run(line);
    };
    rl.on('close', () => { approval?.(false); approval = undefined; });
    rl.on('line', line => {
      if (approval && !line.startsWith('/')) { const resolveApproval = approval; approval = undefined; resolveApproval(/^(si|sí|yes)$/i.test(line.trim())); return; }
      void command(line).catch(e => console.error(e.message));
    });
    const onSignal = () => { approval?.(false); approval = undefined; void controller!.cancel().catch(() => console.error('Abort not confirmed')); };
    const onTerminate = () => { onSignal(); rl.close(); };
    process.on('SIGTERM', onTerminate);
    process.on('SIGINT', onSignal); rl.on('SIGINT', onSignal);
    try {
      if (continuing && controller instanceof ContinuityController) {
        active = controller.continue(continuing, project); const result = await active;
        if (['failed', 'blocked', 'cancelled'].includes(result.status)) process.exitCode = 1;
        console.log(JSON.stringify(summary(result), null, 2));
      } else if (args.length) { run(args.join(' ')); await active; }
      else { console.log('smart> /help for commands'); await new Promise<void>(r => rl.once('close', r)); if (active) { await controller.cancel(); await active; } }
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onTerminate); }
  } finally { approval?.(false); rl.close(); if (controller instanceof ContinuityController) await controller.close(); await backend?.close(); }
}
if (isMain(import.meta.url)) main().catch(e => { console.error(e instanceof Error ? e.message : 'Error'); process.exitCode = 1; });
