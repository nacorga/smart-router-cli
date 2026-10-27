#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isMain } from '../entrypoint.js';
import { defaults, loadConfig } from '../config.js';
import { SmartEngine, type ApprovalProvider } from '../engine/index.js';
import { Store } from '../state.js';
import { FactoryStore } from './state.js';
import { Factory } from './orchestrator.js';
import { DeliveryManager } from './delivery.js';
import { parseTaskSpec, TaskSpecError } from './task-spec.js';
const help = `factory run --spec task.json [--config file] [--run]
factory status <id>                  Safe status and event metadata
factory inspect <id>                 Private task, workspace and check details
factory cancel <id>                  Request cancellation; owner confirms termination
factory continue <id> [--config file] [--run]
factory deliver <id>                 Preview; approve commit/push/Draft PR separately
factory demo                         Interactive offline fixture with real validation

--run permits asking for ONE paid/subscription execution; explicit approval is
still required. Without --run, inference is denied. TaskSpec never grants tools.
No TTY: all approvals denied. State: SMART_STATE_DIR/factory (private, outside repo).
Only confirmed portable checkpoints can continue; uncertain operations require
inspection, never automatic replay. Worktrees are not an OS sandbox.
Only trusted local code should be approved for tests. No automatic installation.`;
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const command = args.shift();
  const take = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error('Missing option value'); args.splice(i, 2); return value; };
  const specPath = take('--spec'), configPath = take('--config'); const runIndex = args.indexOf('--run'), run = runIndex >= 0; if (run) args.splice(runIndex, 1);
  const id = args.shift(); if (args.length || id?.startsWith('-')) throw new Error('Unknown arguments; see --help');
  const store = new FactoryStore();
  let terminal: ReturnType<typeof createInterface> | undefined;
  const approve: ApprovalProvider = async (description, signal) => {
    if (signal?.aborted) return false;
    console.log(description);
    if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log('Denied: an interactive terminal is required.'); return false; }
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    try { return /^(yes|sí|si)$/i.test((await terminal.question('Approve ONE displayed operation? yes/no: ', { signal })).trim()) && !signal?.aborted; } catch { return false; }
  };
  try {
    if (command === 'demo') {
      if (id || specPath || configPath || run) throw new Error('demo takes no options');
      const { demo } = await import('./demo.js'); const result = await demo(approve); console.log(JSON.stringify(result, null, 2)); if (result.state !== 'READY_LOCAL') process.exitCode = 1; return;
    }
    if (command === 'run') {
      if (!specPath || id) throw new Error('Use factory run --spec task.json');
      const spec = parseTaskSpec(JSON.parse(await readFile(resolve(specPath), 'utf8')));
      spec.repository.path = resolve(spec.repository.path);
      const config = await loadConfig(spec.repository.path, configPath);
      const engine = new SmartEngine(new Store(join(store.root, 'engine'), store.projectLockRoot));
      const factory = new Factory(store, engine, config, async (description, signal) => description.startsWith('Authorize ONE Smart Router') && !run ? false : approve(description, signal));
      const result = await factory.run(spec); console.log(JSON.stringify({ id: result.id, state: result.state, workspace: result.workspace?.path, reason: result.reason, originalChangesExcluded: result.workspace?.originalDirty }, null, 2));
      if (!['AWAITING_DELIVERY_APPROVAL', 'READY_LOCAL'].includes(result.state)) process.exitCode = 1;
      return;
    }
    if (!id || specPath) throw new Error('Task ID required; see --help');
    const task = await store.get(id);
    const factory = new Factory(store, new SmartEngine(new Store(join(store.root, 'engine'), store.projectLockRoot)), command === 'continue' ? await loadConfig(task.workspace!.repository, configPath) : structuredClone(defaults), async (description, signal) => description.startsWith('Authorize ONE Smart Router') && !run ? false : approve(description, signal), task.mode);
    if (command === 'inspect') console.log(JSON.stringify(await factory.inspect(id), null, 2));
    else if (command === 'status') { const t = await factory.inspect(id); console.log(JSON.stringify({ id: t.id, state: t.state, mode: t.mode, reason: t.reason, engineStatus: t.engineStatus, engineNote: t.engineNote, checks: t.checks.map(c => ({ status: c.status, exitCode: c.exitCode })), operation: t.operation?.kind, events: t.events }, null, 2)); }
    else if (command === 'cancel') { const t = await factory.cancel(id); console.log(JSON.stringify({ id, state: t.state, reason: t.reason }, null, 2)); }
    else if (command === 'continue') { const t = await factory.continue(id); console.log(JSON.stringify({ id, state: t.state, reason: t.reason }, null, 2)); if (!['AWAITING_DELIVERY_APPROVAL', 'READY_LOCAL'].includes(t.state)) process.exitCode = 1; }
    else if (command === 'deliver') {
      const manager = new DeliveryManager(store, approve);
      console.log(JSON.stringify(await manager.preview(id), null, 2));
      const t = await manager.deliver(id); console.log(JSON.stringify({ id, state: t.state, reason: t.reason, delivery: t.delivery }, null, 2));
      if (!['READY_LOCAL', 'DRAFT_PR_CREATED'].includes(t.state)) process.exitCode = 1;
    } else throw new Error('Unknown command; see --help');
  } finally { terminal?.close(); }
}
if (isMain(import.meta.url)) main().catch(error => { if (error instanceof TaskSpecError) console.error(error.message); console.error('Factory command failed; inspect private state and --help. No operation is automatically replayed.'); process.exitCode = 1; });
