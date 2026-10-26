import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults } from '../config.js';
import { SmartEngine, type ApprovalProvider } from '../engine/index.js';
import { Store } from '../state.js';
import { NativeTools } from '../native-tools.js';
import { Factory } from './orchestrator.js';
import { FactoryStore } from './state.js';
import { git } from './workspace.js';
import { DeliveryManager } from './delivery.js';
/** Fixed local fixture, never accepts user-provided executable code or simulated validation. */
export async function demo(approve: ApprovalProvider) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-demo-'))), repo = join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', '--initial-branch=main']); await git(repo, ['config', 'user.name', 'Factory Fixture']); await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'index.mjs'), 'export const sum = () => 0;\n');
  await writeFile(join(repo, 'test.mjs'), "import {sum} from './index.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5);\n");
  await git(repo, ['add', '--', 'index.mjs', 'test.mjs']); await git(repo, ['commit', '-m', 'fixture base']);
  const store = new FactoryStore(join(root, 'state')), config = structuredClone(defaults);
  config.models = { fast: 'fixture/fast', balanced: 'fixture/balanced', deep: 'fixture/deep' };
  const engine = new SmartEngine(new Store(join(store.root, 'engine'), store.projectLockRoot), async (_d, project, authorize) => ({
    catalog: async () => Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })), create: async () => 'offline', abort: async () => true, close() {},
    prompt: async (_id, _model, _prompt, stage) => {
      let denied = false;
      if (stage === 'implement') {
        const tools = new NativeTools(project, stage, authorize, new AbortController().signal);
        await tools.call('write_file', { path: 'index.mjs', content: 'export const sum = (a, b) => a + b;\n' }); denied = tools.denied;
      }
      return { text: 'Fixed scripted fixture; no model inference', validation: 'none', reviewVerdict: stage === 'review' ? 'passed' : undefined, failure: denied ? 'permission' : undefined, evidence: [], usage: [{ messageId: randomUUID(), inputTokens: 0, outputTokens: 0, source: 'local', costUsd: 0 }] };
    },
  }));
  const factory = new Factory(store, engine, config, approve, 'offline-fixture');
  let task = await factory.run({ version: 1, id: 'offline-sum', title: 'Fix fixture sum', objective: 'Implement sum', repository: { path: repo, baseRef: 'main' }, scope: { allowedPaths: ['index.mjs'], protectedPaths: ['test.mjs'] }, acceptance: ['sum adds operands'], validation: { commands: [{ executable: 'node', args: ['--test', 'test.mjs'], required: true }] }, limits: { maxRepairAttempts: 0, timeoutMinutes: 1 }, delivery: { draftPR: false, requireHumanApproval: true } });
  if (task.state === 'AWAITING_DELIVERY_APPROVAL') task = await new DeliveryManager(store, approve).deliver(task.id);
  return { mode: task.mode, id: task.id, state: task.state, checks: task.checks, privateState: store.root, reason: task.reason, providerRequests: 0, productionPilot: false };
}
