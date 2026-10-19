import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/controller.js';
import { defaults } from '../src/config.js';
import { Store, lockProject } from '../src/state.js';
import type { Backend, Config, Model, Result, StageKind } from '../src/types.js';
class Fake implements Backend {
  prepare?: (id: string) => Promise<void>;
  requests: { model: string; stage: StageKind; prompt: string }[] = [];
  behavior: (stage: StageKind, count: number) => Partial<Result> = () => ({});
  async catalog(): Promise<Model[]> { return ['fast', 'balanced', 'deep'].map(t => ({ id: `p/${t}`, tools: true, context: 64000 })); }
  async create() { return 's-1'; }
  async prompt(_id: string, model: string, prompt: string, stage: StageKind): Promise<Result> {
    this.requests.push({ model, stage, prompt });
    return { text: 'OBSERVATION', usage: [{ messageId: randomUUID(), inputTokens: 10, outputTokens: 10, costUsd: 0.01, source: 'backend' }], validation: stage === 'validate' ? 'passed' : 'none', evidence: [], ...this.behavior(stage, this.requests.filter(r => r.stage === stage).length) };
  }
  async abort() { return true; }
  close() {}
}
let root: string, project: string, store: Store, fake: Fake, cfg: Config;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'smart-test-')); project = join(root, 'project'); const { mkdir } = await import('node:fs/promises'); await mkdir(project); store = new Store(join(root, 'state')); fake = new Fake(); cfg = structuredClone(defaults); cfg.models = { fast: 'p/fast', balanced: 'p/balanced', deep: 'p/deep' }; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const ctl = () => new Controller(fake, cfg, store, () => {});
describe('task lifecycle', () => {
  it('completes a one-stage read', async () => { const t = await ctl().run('Busca parser', project); expect(t.status).toBe('completed'); expect(t.calls).toBe(1); });
  it('transfers objective and observations between stages', async () => { const t = await ctl().run('Migra múltiples módulos', project); expect(t.status).toBe('completed'); expect(new Set(fake.requests.map(r => r.model)).size).toBe(3); expect(fake.requests[1]!.prompt).toContain('OBSERVATION'); expect(fake.requests[1]!.prompt).toContain('Migra múltiples módulos'); });
  it('repairs once then escalates after reproduced validation failure', async () => {
    fake.behavior = (stage, n) => stage === 'validate' && n <= 2 ? { validation: 'failed', evidence: ['test:failed'] } : {};
    const t = await ctl().run('Implementa parser', project);
    expect(t.status).toBe('completed'); expect(fake.requests.filter(r => r.stage === 'validate').map(r => r.model)).toEqual(['p/balanced', 'p/balanced', 'p/deep']);
  });
  it('stops at escalation limits', async () => { fake.behavior = stage => stage === 'validate' ? { validation: 'failed' } : {}; const t = await ctl().run('Implementa parser', project); expect(t.status).toBe('failed'); expect(t.calls).toBeLessThanOrEqual(7); });
  it('requires the same validation to fail again before escalating', async () => {
    fake.behavior = (stage, n) => stage === 'validate' ? { validation: 'failed', evidence: [`different-${n}:failed`] } : {};
    const t = await ctl().run('Implementa parser', project); expect(t.status).toBe('failed'); expect(fake.requests.filter(r => r.stage === 'validate').map(r => r.model)).toEqual(['p/balanced','p/balanced']);
  });
  it('accepts actual validation within a single trivial edit stage', async () => { fake.behavior = () => ({validation:'passed', evidence:['test:passed']}); const t = await ctl().run('Corrige errata README', project); expect(t.status).toBe('completed'); expect(t.calls).toBe(1); });
  it('does not escalate infrastructure failures', async () => { fake.behavior = () => ({ failure: 'infrastructure', retryable: true } as Partial<Result>); const t = await ctl().run('Busca parser', project); expect(t.status).toBe('blocked'); expect(fake.requests.map(r => r.model)).toEqual(['p/fast', 'p/fast']); });
  it('does not retry denied permissions', async () => { fake.behavior = () => ({ failure: 'permission' }); const t = await ctl().run('Implementa parser', project); expect(t.calls).toBe(1); expect(t.status).toBe('blocked'); });
  it('blocks before first call when budget is zero', async () => { cfg.limits.maxCostUsd = 0; const t = await ctl().run('Busca parser', project); expect(t.calls).toBe(0); });
  it('blocks next call once budget is exhausted', async () => { cfg.limits.maxCostUsd = 0.01; const t = await ctl().run('Implementa parser', project); expect(t.calls).toBe(1); expect(t.status).toBe('blocked'); });
  it('blocks when approximate next cost exceeds budget', async () => { fake.catalog = async () => [{ id: 'p/fast', tools: true, context: 64000, inputPrice: 1000, outputPrice: 1000 }]; const t = await ctl().run('Busca parser', project); expect(t.calls).toBe(0); expect(t.status).toBe('blocked'); });
  it('never presents missing usage as zero cost', async () => { fake.behavior = () => ({ usage: [{ messageId: 'm', inputTokens: 1, outputTokens: 1, source: 'unknown' }] }); const t = await ctl().run('Busca parser', project); expect(t.unknownCost).toBe(true); expect(t.status).toBe('blocked'); });
  it('marks edits with no validation as unverified', async () => { fake.behavior = () => ({ validation: 'none' }); expect((await ctl().run('Implementa parser', project)).status).toBe('unverified'); });
  it('does not replay uncertain responses', async () => { fake.prompt = async () => { throw new Error('network'); }; const t = await ctl().run('Implementa parser', project); expect(t.calls).toBe(1); expect(t.status).toBe('blocked'); expect(t.unknownCost).toBe(true); });
  it('records Git preflight and instruction names without copying file content',async()=>{
    const {execFile}=await import('node:child_process'); const {promisify}=await import('node:util');
    await promisify(execFile)('git',['init','--initial-branch=fixture',project]);
    await writeFile(join(project,'AGENTS.md'),'PRIVATE_INSTRUCTION_CONTENT');
    await writeFile(join(project,'dirty.txt'),'USER EDIT');
    const task=await ctl().run('Busca parser',project);
    expect(task.project).toEqual({git:true,branch:'fixture',dirty:true,instructionFiles:['AGENTS.md']});
    const persisted=await readFile(join(store.root,`${task.id}.json`),'utf8');
    expect(persisted).not.toContain('PRIVATE_INSTRUCTION_CONTENT');
    expect(await readFile(join(project,'dirty.txt'),'utf8')).toBe('USER EDIT');
  });
  it('preserves pre-existing files', async () => { await writeFile(join(project, 'dirty.txt'), 'USER EDIT'); await ctl().run('Implementa parser', project); expect(await readFile(join(project, 'dirty.txt'), 'utf8')).toBe('USER EDIT'); });
  it('persists references, not request or response content', async () => { const t = await ctl().run('Busca PRIVATE_REQUEST', project); const persisted = await readFile(join(store.root, `${t.id}.json`), 'utf8'); expect(persisted).not.toContain('PRIVATE_REQUEST'); expect(persisted).not.toContain('OBSERVATION'); expect(persisted).toContain('s-1'); });
  it('resume inspects checkpoints without backend calls', async () => { const c = ctl(); const t = await c.run('Busca parser', project); await c.resume(t.id, project); expect(fake.requests).toHaveLength(1); });
  it('does not lose immediate cancellation while acquiring the project lock', async () => {
    const c = ctl(); const running = c.run('Implementa parser', project); await c.cancel();
    const task = await running; expect(task.status).toBe('cancelled'); expect(task.calls).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  it('cancels during preflight without creating a session', async () => {
    const c = ctl(); let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const waiting = new Promise<void>(r => { release = r; });
    const originalCatalog = fake.catalog.bind(fake); let created = 0;
    fake.catalog = async () => { started(); await waiting; return originalCatalog(); };
    fake.create = async () => { created++; return 'unexpected'; };
    const running = c.run('Implementa parser', project); await entered; await c.cancel(); release();
    const task = await running; expect(task.status).toBe('cancelled'); expect(created).toBe(0); expect(task.calls).toBe(0);
  });
  it('does not abort an inactive historical session', async () => {
    const c = ctl(); await c.run('Busca parser', project); let aborted = 0;
    fake.abort = async () => { aborted++; return true; }; await c.cancel(); expect(aborted).toBe(0);
  });
  it('cancels and prevents subsequent calls', async () => { const c = ctl(); fake.behavior = () => { void c.cancel(); return {}; }; const t = await c.run('Implementa parser', project); expect(t.status).toBe('cancelled'); expect(t.calls).toBe(1); });
  it('continues a recovered session only after an explicit new request', async () => {
    const c = ctl(); const first = await c.run('Busca parser', project);
    let prepared = ''; fake.prepare = async id => { prepared = id; };
    first.status = 'running'; await store.save(first); // Simulate a crash checkpoint whose native session is now idle.
    await c.resume(first.id, project); expect(fake.requests).toHaveLength(1);
    const second = await c.run('Explica el resultado anterior', project);
    expect(prepared).toBe(first.sessionId); expect(second.sessionId).toBe(first.sessionId); expect(fake.requests).toHaveLength(2);
  });
  it('blocks a continuation if the backend cannot prove an idle session', async () => {
    const c = ctl(); const first = await c.run('Busca parser', project); await c.resume(first.id, project);
    fake.prepare = async () => { throw new Error('busy'); };
    const second = await c.run('Explica más', project); expect(second.status).toBe('blocked'); expect(fake.requests).toHaveLength(1);
  });
  it('blocks empty usage instead of claiming a free successful request', async () => { fake.behavior = () => ({usage:[]}); const t = await ctl().run('Busca parser', project); expect(t.status).toBe('blocked'); expect(t.unknownCost).toBe(true); });
  it('does not report a successful sensitive review when its verdict is absent', async () => { const t = await ctl().run('Refactoriza el checkout', project); expect(t.status).toBe('unverified'); expect(t.note).toBe('REVIEW_REQUIRES_ATTENTION'); });
  it('applies manual models at boundaries', async () => { const c = ctl(); c.preferredModel = () => 'deep'; const t = await c.run('Implementa parser', project); expect(t.status).toBe('completed'); expect(fake.requests.every(r => r.model === 'p/deep')).toBe(true); });
});
describe('persistence and locks', () => {
  it('rejects two writers and allows subsequent use after release', async () => { const release = await lockProject(project, store.root); await expect(lockProject(project, store.root)).rejects.toThrow('locked'); await release(); const second = await lockProject(project, store.root); await second(); });
  it('rejects path traversal ids', async () => { await expect(store.get('../../secrets')).rejects.toThrow('Invalid'); });
  it('leaves no intermediate state files', async () => { await ctl().run('Busca parser', project); expect((await readdir(store.root)).filter(f => !f.endsWith('.json'))).toEqual([]); });
});

describe('persisted validation evidence',()=>{
  it('retains failed repairs and final validation without response content',async()=>{
    fake.behavior=(stage,count)=>stage==='validate'?{validation:count<3?'failed':'passed',evidence:[count<3?'same-test:failed':'same-test:passed']}:{};
    const task=await ctl().run('Implementa parser',project);const saved=await store.get(task.id);
    const attempts=saved.stages.find(s=>s.kind==='validate')!.attempts!;
    expect(attempts.map(a=>a.validation)).toEqual(['failed','failed','passed']);
    expect(attempts.map(a=>a.modelId)).toEqual(['p/balanced','p/balanced','p/deep']);
    expect(attempts[0]!.evidence).toEqual(['same-test:failed']);
    expect(JSON.stringify(saved)).not.toContain('OBSERVATION');
  });
  it('records uncertainty instead of inventing a validation after a transport failure',async()=>{
    fake.prompt=async()=>{throw new Error('private backend response');};
    const task=await ctl().run('Busca parser',project);const attempt=(await store.get(task.id)).stages[0]!.attempts![0]!;
    expect(attempt.responseUncertain).toBe(true);expect(attempt.validation).toBe('none');expect(task.unknownCost).toBe(true);
    expect(JSON.stringify(await store.get(task.id))).not.toContain('private backend response');
  });
});

it('stops at a local operational guard without repair, retry or escalation', async () => {
  fake.behavior=()=>({failure:'limit',retryable:true,validation:'passed',evidence:['test:passed']});
  const task=await ctl().run('Implementa parser',project);
  expect(task.status).toBe('blocked');expect(task.note).toBe('LOCAL_GUARD_DENIED');
  expect(task.calls).toBe(1);expect(fake.requests.map(r=>r.model)).toEqual(['p/fast']);
  expect(task.stages[0]!.attempts![0]!.failure).toBe('limit');
});
