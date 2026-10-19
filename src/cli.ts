#!/usr/bin/env node
import { loadLocalEnv } from './env.js';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaults, loadConfig, requireConfigured } from './config.js';
import { Store, projectRoot } from './state.js';
import { OpenCodeBackend } from './opencode.js';
import { DemoBackend } from './demo.js';
import { Controller } from './controller.js';
import type { Backend, Config, Task } from './types.js';
const help = `smart "task" [--config file] [--demo] [--deep-only]
smart                 Interactive mode
smart --init          Write configuration with model placeholders
smart --sessions      List project tasks
smart --resume [id]   Load metadata without replaying actions
smart --export [id]   Export a summary without prompt contents
smart --plan "task"   Preview routing without provider requests
Commands: /mode auto|manual, /model fast|balanced|deep|provider/id,
/budget USD, /status, /history, /sessions, /resume [id], /cancel, /help, /exit
Permissions: reply "yes" only for the displayed operation. Ctrl-C cancels.`;
export function summary(task: Task) {
  return { id: task.id, project:task.project, status: task.status, mode:task.mode, override:task.override, budget:task.budget, remainingBudgetUsd:task.unknownCost?null:Math.max(0,task.budget-task.spent), spent: task.spent, unknownCost: task.unknownCost, calls: task.calls, stages: task.stages, usage: task.usage, note: task.note, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`); args.splice(i, 2); return value; };
  const configPath = take('--config');
  const flag = (f: string) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  if (flag('--help') || flag('-h')) { console.log(help); return; }
  if (flag('--init')) { const path = resolve('smart-router.config.json'); await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(`Configure ${path}. Models: provider/vendor/model-id; key: OPENROUTER_API_KEY.`); return; }
  const project = await projectRoot(process.cwd()); const store = new Store();
  if (flag('--sessions')) { console.log((await store.list(project)).map(t => `${t.id} ${t.status} ${t.updatedAt}`).join('\n')); return; }
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
  if (demo) { config.models = { fast: 'demo/fast', balanced: 'demo/balanced', deep: 'demo/deep' }; console.log('OFFLINE DEMO: no edits, no real costs, no provider validation.'); }
  if (deepOnly) config.mode = 'manual';
  const { classify, plan, routeTarget } = await import('./router.js');
  if (planOnly) {
    const c = classify(args.join(' '));
    const override = deepOnly ? 'deep' : config.mode === 'manual' ? 'balanced' : undefined;
    console.log(JSON.stringify({ classification:c, availabilityChecked:false, stages:plan(c).map(s => ({kind:s.kind,...routeTarget(s,c,config,override)})) },null,2)); return;
  }
  if (!demo) await loadLocalEnv(project);
  requireConfigured(config);
  if (!demo && !process.env.OPENROUTER_API_KEY && config.provider === 'openrouter') throw new Error('Missing OPENROUTER_API_KEY; use --demo or configure the key locally.');
  console.log(`Project: ${project}\nBackend: OpenCode SDK/server 1.19.3 · provider: ${demo ? 'demo' : config.provider} · budget $${config.limits.maxCostUsd}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let approval: ((b: boolean) => void) | undefined;
  const approve = async (description: string) => {
    if (!process.stdin.isTTY) { console.log(`Permission denied in non-interactive mode: ${description}`); return false; }
    if (approval) return false;
    console.log(`Approve ONE operation: ${description}\nReply yes/no:`);
    return new Promise<boolean>(r => { approval = r; });
  };
  let backend: Backend | undefined; let active: Promise<Task> | undefined; let controller: Controller | undefined;
  let chosen: string | undefined = deepOnly ? 'deep' : config.mode === 'manual' ? 'balanced' : undefined;
  const run = (request: string) => {
    if (!controller || active) { console.log('A task is active. Use /cancel or wait.'); return; }
    active = controller.run(request, project).then(t => { if (!demo && ['failed', 'blocked', 'cancelled'].includes(t.status)) process.exitCode = 1; return t; }).catch(error => { console.error(error instanceof Error ? error.message : 'Task error'); process.exitCode = 1; return controller!.task!; }).finally(() => { active = undefined; if (!args.length) console.log('smart>'); });
  };
  try {
    backend = demo ? new DemoBackend() : await OpenCodeBackend.start(project, approve);
    controller = new Controller(backend, config, store);
    controller.preferredModel = () => chosen;
    const command = async (line: string) => {
      const [cmd, ...rest] = line.trim().split(/\s+/); const value = rest.join(' ');
      if (!cmd) return;
      if (cmd === '/cancel') { approval?.(false); approval = undefined; await controller!.cancel(); }
      else if (cmd === '/mode') { if (!['auto', 'manual'].includes(value)) throw new Error('Use /mode auto|manual'); config.mode = value as Config['mode']; chosen = value === 'auto' ? undefined : chosen ?? 'balanced'; if (controller!.task) controller!.task.mode = config.mode; }
      else if (cmd === '/model') { if (!value) throw new Error('Specify a tier or provider/model'); chosen = value; config.mode = 'manual'; console.log(`Override: ${chosen}`); }
      else if (cmd === '/budget') { const n = Number(value); if (!value || !Number.isFinite(n) || n < 0) throw new Error('Invalid budget'); config.limits.maxCostUsd = n; if (controller!.task) controller!.task.budget = n; }
      else if (cmd === '/status') console.log(controller!.task ? JSON.stringify(summary(controller!.task), null, 2) : 'No task');
      else if (cmd === '/history') console.log(JSON.stringify(controller!.task?.stages.flatMap(s => s.decisions) ?? [], null, 2));
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
      if (args.length) { run(args.join(' ')); await active; }
      else { console.log('smart> /help for commands'); await new Promise<void>(r => rl.once('close', r)); if (active) { await controller.cancel(); await active; } }
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onTerminate); }
  } finally { approval?.(false); rl.close(); await backend?.close(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Error'); process.exitCode = 1; });
