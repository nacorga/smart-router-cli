import { repositoryFixture } from './factory-repository.js';
import { mkdtemp, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from '../src/factory/workspace.js';
import { FactoryStore } from '../src/factory/state.js';
import { SmartEngine } from '../src/engine/index.js';
import { Store } from '../src/state.js';
import { defaults } from '../src/config.js';
import { NativeTools } from '../src/native-tools.js';
import { Factory } from '../src/factory/orchestrator.js';
import type { TaskSpec } from '../src/factory/task-spec.js';
import type { ApprovalProvider } from '../src/engine/index.js';
import type { Backend, Result } from '../src/types.js';
export async function fixture(id = 'fixture-task', behavior: 'correct' | 'broken' | 'protected' | 'outside' | 'denied' | 'uncertain' = 'correct', approve: ApprovalProvider = async () => true) {
  const base = await repositoryFixture(id); const { root, repo, spec } = base;
  const store = new FactoryStore(base.stateRoot); await store.init();
  const config = structuredClone(defaults); config.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' };
  config.limits.repairAttemptsBeforeEscalation = 0; config.limits.maxEscalationsPerStage = 0;
  let requests = 0;
  const engine = new SmartEngine(new Store(join(store.root, 'engine')), async (_d, project, authorize) => ({
    catalog: async () => Object.values(config.models).map(id => ({ id, tools: true, context: 64000 })),
    create: async () => 'fixture', abort: async () => true, close() {},
    prompt: async (_id, _model, _prompt, stage): Promise<Result> => {
      requests++;
      if (behavior === 'uncertain') throw new Error('uncertain');
      if (stage === 'implement') {
        if (behavior === 'protected') await writeFile(join(project, '.env'), 'altered');
        else if (behavior === 'outside') await writeFile(join(project, 'outside.mjs'), 'unscoped');
        else {
          const tools = new NativeTools(project, stage, behavior === 'denied' ? async () => false : authorize, new AbortController().signal);
          await tools.call('write_file', { path: 'index.mjs', content: behavior === 'broken' ? 'export const sum = () => 0;\n' : 'export const sum = (a, b) => a + b;\n' });
          if (tools.denied) return { text: 'tests passed', validation: 'none', failure: 'permission', evidence: [], usage: [{ messageId: randomUUID(), inputTokens: 0, outputTokens: 0, source: 'local', costUsd: 0 }] };
        }
      }
      return { text: 'tests passed (untrusted claim)', validation: 'none', evidence: [], usage: [{ messageId: randomUUID(), inputTokens: 0, outputTokens: 0, source: 'local', costUsd: 0 }] };
    },
  } satisfies Backend));
  const factory = new Factory(store, engine, config, approve, 'offline-fixture');
  return { root, repo, store, spec, config, factory, requests: () => requests, cleanup: () => rm(root, { recursive: true, force: true }) };
}
