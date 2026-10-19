import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/controller.js';
import { Store } from '../src/state.js';
import { OpenRouterMeter, meteredBackend } from '../src/openrouter-meter.js';
import { smokeConfig } from '../src/smoke-fixture.js';
import { validationEvidence } from '../src/opencode.js';
import type { Backend, Result, StageKind } from '../src/types.js';

// Real loopback HTTP + production meter/controller. A scripted transport shim replaces
// OpenCode/model reasoning; native tools/permissions have their separate native smokes.
type Scenario = 'rate' | 'overload' | 'reject' | 'truncated' | 'timeout' | 'unknown' | 'prose' | 'guard' | 'cancel';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'smart-fault-')), project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'user.txt'), 'existing work');
  let requests = 0, aborts = 0, release!: () => void;
  const entered = new Promise<void>(r => { release = r; });
  const models = new Map<string, string>(); const known = new Map<string, boolean>();
  const server: Server = createServer((req, res) => { void (async () => {
    expect(req.headers.authorization).toBe('Bearer local-fault-only');
    if (req.url?.startsWith('/generation?id=')) {
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id')!;
      if (!known.get(id)) { res.writeHead(404).end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { id, model: models.get(id), total_cost: 0, native_tokens_prompt: 1, native_tokens_completion: 1, finish_reason: 'stop' } })); return;
    }
    expect(req.method).toBe('POST'); expect(req.url).toBe('/chat/completions');
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests++; release();
    if (scenario === 'timeout' || scenario === 'cancel') return; // Abort closes this in-flight local request.
    if (scenario === 'truncated') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":'); return; }
    if (scenario === 'guard') { res.writeHead(403, { 'content-type': 'application/json', 'x-smart-router-local-denial': 'fixture-nonce' }).end('{"error":"local guard"}'); return; }
    const id = 'gen-fault-fixture-' + requests; models.set(id, body.model); known.set(id, scenario !== 'unknown' && scenario !== 'reject');
    res.writeHead(scenario === 'rate' ? 429 : scenario === 'overload' ? 503 : scenario === 'reject' ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, text: 'All tests passed. Task complete.' }));
  })().catch(() => res.destroy()); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const meter = await OpenRouterMeter.start('local-fault-only', `http://127.0.0.1:${address.port}`, [], scenario === 'guard' ? { localDenialToken: 'fixture-nonce' } : {});
  let active: AbortController | undefined;
  const transport: Backend = {
    catalog: async () => Object.values(smokeConfig().models).map(id => ({ id, tools: true, context: 200000 })),
    create: async () => 'fixture-session', prepare: async () => {}, close: () => {},
    abort: async () => { aborts++; active?.abort(); return true; },
    prompt: async (_id: string, model: string, _prompt: string, _stage: StageKind): Promise<Result> => {
      active = new AbortController();
      const response = await fetch(`${meter.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-fault-only' }, body: JSON.stringify({ model: model.replace('openrouter/', '') }), signal: scenario === 'timeout' ? AbortSignal.any([active.signal, AbortSignal.timeout(250)]) : active.signal });
      const data = await response.json() as { text?: string };
      const evidence = validationEvidence([{ type: 'text', text: data.text ?? '' }]);
      return { text: data.text ?? '', usage: [], validation: evidence.length ? 'passed' : 'none', evidence,
        failure: response.ok ? undefined : 'infrastructure', retryable: [429, 503].includes(response.status) };
    },
  };
  const store = new Store(join(root, 'state')); const config = smokeConfig();
  const backend = meteredBackend(transport, meter, () => {}); const controller = new Controller(backend, config, store, () => {});
  cleanup.push(async () => { active?.abort(); meter.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); });
  return { controller, project, store, entered, config, requests: () => requests, aborts: () => aborts };
}
describe('reliability failure injection without credentials or paid inference', () => {
  it.each(['rate', 'overload'] as const)('stops HTTP %s without retry when the error has no cost evidence', async scenario => {
    const f = await fixture(scenario); const task = await f.controller.run('Locate the parser', f.project);
    expect(task.status).toBe('blocked'); expect(task.note).toBe('COST_UNAVAILABLE_INSPECT_PROVIDER'); expect(f.requests()).toBe(1);
    expect(task.unknownCost).toBe(true); expect(task.usage.some(u => u.costUsd === undefined)).toBe(true);
    expect(new Set(task.stages.flatMap(s => s.decisions.map(d => d.modelId))).size).toBe(1);
  });
  it.each(['reject', 'unknown'] as const)('stops %s on unavailable cost instead of retrying or claiming zero', async scenario => {
    const f = await fixture(scenario); const task = await f.controller.run('Locate the parser', f.project);
    expect(task.status).toBe('blocked'); expect(task.unknownCost).toBe(true); expect(task.note).toBe('COST_UNAVAILABLE_INSPECT_PROVIDER'); expect(f.requests()).toBe(1);
    expect(task.usage.some(u => u.source === 'unknown' && u.costUsd === undefined)).toBe(true);
  });
  it.each(['truncated', 'timeout'] as const)('does not replay an uncertain %s response and persists inspectable evidence', async scenario => {
    const f = await fixture(scenario); const task = await f.controller.run('Implement a parser', f.project);
    expect(task.status).toBe('blocked'); expect(task.unknownCost).toBe(true); expect(f.requests()).toBe(1);
    expect(task.note).toBe('BACKEND_RESPONSE_UNCERTAIN_INSPECT_SESSION');
    expect((await f.store.get(task.id)).stages[0]!.attempts![0]!.responseUncertain).toBe(true);
    await f.controller.resume(task.id, f.project); expect(f.requests()).toBe(1);
  });
  it('rejects claimed success without actual tool exit evidence', async () => {
    const f = await fixture('prose'); const task = await f.controller.run('Implement a parser', f.project);
    expect(task.status).toBe('unverified'); expect(task.stages.every(s => s.attempts?.every(a => a.validation === 'none'))).toBe(true);
    expect(await readFile(join(f.project, 'user.txt'), 'utf8')).toBe('existing work');
  });
  it('keeps proven local guard denial distinct from provider errors without retrying', async () => {
    const f = await fixture('guard'); const task = await f.controller.run('Implement a parser', f.project);
    expect(task.status).toBe('blocked'); expect(task.note).toBe('LOCAL_GUARD_DENIED'); expect(task.unknownCost).toBe(false); expect(f.requests()).toBe(1);
    expect(task.usage[0]).toMatchObject({ costUsd: 0, source: 'local' });
  });
  it('cancels an active HTTP request and inspection never replays it', async () => {
    const f = await fixture('cancel'); const running = f.controller.run('Implement a parser', f.project); await f.entered;
    expect(await f.controller.cancel()).toBe(true); const task = await running;
    expect(task.status).toBe('cancelled'); expect(task.unknownCost).toBe(true); expect(f.aborts()).toBe(1); expect(f.requests()).toBe(1);
    await f.controller.resume(task.id, f.project); expect(f.requests()).toBe(1);
    expect(await readFile(join(f.project, 'user.txt'), 'utf8')).toBe('existing work');
  });
  it('blocks before any inference when the task budget is zero', async () => {
    const f = await fixture('prose'); f.config.limits.maxCostUsd = 0;
    const task = await f.controller.run('Implement a parser', f.project);
    expect(task.status).toBe('blocked'); expect(task.calls).toBe(0); expect(f.requests()).toBe(0);
  });
});
