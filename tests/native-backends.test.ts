import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBackend, ClaudeBackend } from '../src/native-backends.js';
import { JsonLines, subscriptionEnvironment } from '../src/native-transport.js';
import type { Destination } from '../src/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(scenario: 'ok' | 'api' | 'unexpected' | 'truncated' | 'version' | 'quota' | 'quota-after' | 'generic-rate' | 'plugins' = 'ok', provider: 'claude' | 'codex' = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'smart-native-fixture-'));
  const executable = join(root, 'native.mjs'), log = join(root, 'methods.jsonl');
  const fixtureSource = `#!/usr/bin/env node
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2), scenario=${JSON.stringify(scenario)}, provider=${JSON.stringify(provider)};
if(args.includes('--version')) { console.log(scenario==='version'?'0.0.0':provider==='claude'?'2.1.303 (Claude Code)':'codex-cli 0.163.0-alpha.10.2'); process.exit(0); }
if(args[0]==='plugin') { console.log(JSON.stringify(scenario==='plugins'?{}:[{id:'fixture@local',enabled:true}])); process.exit(0); }
if(args[0]==='auth') { console.log(JSON.stringify({loggedIn:true,authMethod:scenario==='api'?'api_key':'claude.ai'})); process.exit(0); }
if(args[0]==='features') { console.log('shell_tool stable true\\nhooks stable true\\nplugins stable true\\napps stable true\\nview_image stable true\\nmulti_agent_v2 stable true');process.exit(0); }
if(provider==='codex') {
 const lines=createInterface({input:process.stdin});
 for await(const line of lines) { const m=JSON.parse(line); await fs.appendFile(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n'); if(m.id===undefined)continue;
 const result=m.method==='initialize'?{serverInfo:{}}:m.method==='account/read'?{account:{type:scenario==='api'?'apiKey':'chatgpt'}}:{rateLimits:{primary:{usedPercent:100,resetsAt:2000000000}}};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n'); }
} else {
 for await(const c of process.stdin){};
 if(!args.includes('--restricted')||!args.includes('--strict-mcp-config')||args[args.indexOf('--tools')+1]!==''||args[args.indexOf('--setting-sources')+1]!=='') process.exit(2);
 const tools=['mcp__smart__read_file','mcp__smart__write_file','mcp__smart__run_command','mcp__smart__permission'];
 if(scenario==='unexpected')tools.push('Bash');
 process.stdout.write(JSON.stringify({type:'system',subtype:'init',tools,model:'claude-sonnet-fixture',plugins:[]})+'\\n');
 if(scenario==='unexpected'){ await new Promise(r=>setTimeout(r,1000)); process.exit(3); }
 const quota=()=>process.stdout.write(JSON.stringify({type:'rate_limit_event',session_id:args.at(-1),rate_limit_info:{status:'rejected',...(scenario==='generic-rate'?{}:{errorCode:'credits_required'}),resetsAt:2000000000}})+'\\n');
 if(scenario==='quota'||scenario==='generic-rate'){quota();process.exit(0);}
 const settings=JSON.parse(await fs.readFile(args[args.indexOf('--settings')+1],'utf8'));if(settings.enabledPlugins['fixture@local']!==false)process.exit(4);
 const cfg=JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.smart;
 const url=cfg.args.at(-2),token=cfg.args.at(-1);
 const call=async(name,args)=>await(await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({name,arguments:args})})).json();
 const written=await call('write_file',{path:'sum.mjs',content:'export default 3;\\n'});
 if(!written.isError)await call('run_command',{command:'npm test'});
 if(scenario==='quota-after')quota();
 const out=JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Done',usage:{input_tokens:10,output_tokens:2}});
 process.stdout.write(scenario==='truncated'?out:out+'\\n');
}
`;
  await writeFile(executable, fixtureSource, { mode: 0o700 });
  await writeFile(join(root, 'sum.mjs'), 'export default 0;\n');
  await writeFile(join(root, 'user.txt'), 'existing work');
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
  await writeFile(join(root, 'check.mjs'), "import value from './sum.mjs'; import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(value,3); assert.equal(fs.readFileSync('user.txt','utf8'),'existing work');");
  const destination: Destination = { id: provider, backend: provider, billing: 'subscription', models: { fast: 'sonnet', balanced: 'sonnet', deep: 'sonnet' }, executable };
  cleanup.push(() => rm(root, { recursive: true, force: true })); return { root, destination, log };
}
describe('native subscription contracts without real inference', () => {
  it('parses fragmented events and rejects truncated output', () => {
    const values: unknown[] = [], parser = new JsonLines(v => values.push(v)); parser.push('{"type":'); parser.push('"result"}\n'); parser.finish(); expect(values).toHaveLength(1);
    parser.push('{"unfinished":'); expect(() => parser.finish()).toThrow('TRUNCATED');
  });
  it('does not inherit API authentication into subscription children', () => {
    const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'fixture-only';
    try { expect(subscriptionEnvironment().ANTHROPIC_API_KEY).toBeUndefined(); expect(subscriptionEnvironment().CLAUDE_CODE_DISABLE_FILE_MENTIONS).toBe('1'); }
    finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
  });
  it('executes an approved write and actual validation through the private bridge', async () => {
    const f = await fixture(), approvals: string[] = [], b = new ClaudeBackend(f.destination, f.root, async d => { approvals.push(d); return true; }); cleanup.unshift(() => b.close());
    expect(await b.probe()).toMatchObject({ authenticated: true, policyEnforced: true });
    const result = await b.prompt(await b.create(), 'sonnet', 'Implement a sum', 'implement', () => {});
    expect(result.validation).toBe('passed'); expect(result.evidence).toHaveLength(1); expect(result.toolsExecuted).toBe(true); expect(approvals).toHaveLength(2);
    expect(await readFile(join(f.root, 'sum.mjs'), 'utf8')).toBe('export default 3;\n');
    expect(result.usage[0]!.costUsd).toBeUndefined();
  });
  it('refuses writes in read-only stages despite claimed successful output', async () => {
    const f = await fixture(), b = new ClaudeBackend(f.destination, f.root, async () => true); cleanup.unshift(() => b.close()); await b.probe();
    const result = await b.prompt(await b.create(), 'sonnet', 'Read the sum', 'explore', () => {});
    expect(result.failure).toBe('permission'); expect(result.validation).toBe('none'); expect(await readFile(join(f.root, 'sum.mjs'), 'utf8')).toBe('export default 0;\n');
  });
  it('refuses a denied write without invoking validation', async () => {
    const f = await fixture(), b = new ClaudeBackend(f.destination, f.root, async () => false); cleanup.unshift(() => b.close()); await b.probe();
    expect((await b.prompt(await b.create(), 'sonnet', 'Implement', 'implement', () => {})).failure).toBe('permission');
    expect(await readFile(join(f.root, 'sum.mjs'), 'utf8')).toBe('export default 0;\n');
  });
  it.each(['unexpected', 'truncated'] as const)('blocks %s protocol output', async scenario => {
    const f = await fixture(scenario), b = new ClaudeBackend(f.destination, f.root, async () => true); cleanup.unshift(() => b.close()); await b.probe();
    await expect(b.prompt(await b.create(), 'sonnet', 'Implement', 'implement', () => {})).rejects.toThrow();
  });
  it.each(['api', 'version', 'plugins'] as const)('blocks Claude preflight for %s', async scenario => {
    const f = await fixture(scenario), b = new ClaudeBackend(f.destination, f.root, async () => true); cleanup.unshift(() => b.close());
    const probe = await b.probe(); expect(probe.authenticated && probe.policyEnforced).toBe(false);
    await expect(b.prompt(await b.create(), 'sonnet', 'Do work', 'implement', () => {})).rejects.toThrow('PREFLIGHT');
  });
  it.each(['quota', 'quota-after'] as const)('uses documented Claude subscription quota signals: %s', async scenario => {
    const f = await fixture(scenario), b = new ClaudeBackend(f.destination, f.root, async () => true); cleanup.unshift(() => b.close()); await b.probe();
    const result = await b.prompt(await b.create(), 'sonnet', 'Implement', 'implement', () => {});
    expect(result.failure).toBe('quota'); expect(result.rejectedBeforeTools).toBe(scenario === 'quota');
    expect(result.toolsExecuted).toBe(scenario === 'quota-after'); expect(await b.availability()).toMatchObject({ state: 'exhausted', source: 'SDKRateLimitEvent' });
  });
  it('does not interpret a generic Claude rate rejection as subscription exhaustion', async () => {
    const f = await fixture('generic-rate'), b = new ClaudeBackend(f.destination, f.root, async () => true); cleanup.unshift(() => b.close()); await b.probe();
    await expect(b.prompt(await b.create(), 'sonnet', 'Implement', 'implement', () => {})).rejects.toThrow('UNCERTAIN');
    expect(await b.availability()).toMatchObject({ state: 'unknown' });
  });
  it('blocks incomplete Codex protocol diagnostics without inference', async () => {
    const f = await fixture('ok', 'codex'), b = new CodexBackend(f.destination, f.root); cleanup.unshift(() => b.close());
    expect(await b.probe()).toMatchObject({ authenticated: false, policyEnforced: false, reason: 'CODEX_MODEL_NOT_AVAILABLE' });
    expect(await b.availability()).toMatchObject({ state: 'unavailable' }); await expect(b.create()).rejects.toThrow('POLICY');
    expect(await readFile(f.log, 'utf8')).not.toContain('turn/start');
  });
});

it('serves the actual MCP stdio bridge with fragmented input', async () => {
  const { createServer } = await import('node:http'); const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url'); const { createRequire } = await import('node:module');
  let forwarded = 0;
  const server = createServer((req, res) => { void (async () => {
    expect(req.headers.authorization).toBe('Bearer local-fixture-token');
    for await (const _ of req) { /* Drain input. */ } forwarded++;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'fixture contents' }] }));
  })(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../src/continuity-mcp.ts', import.meta.url)), `http://127.0.0.1:${address.port}`, 'local-fixture-token'], { stdio: 'pipe' });
  cleanup.unshift(async () => { child.kill(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  let buffer = ''; const values: any[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    child.on('error', reject); child.stdout.on('data', b => {
      buffer += b.toString(); let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { values.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
      if (values.length === 4) resolve();
    });
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initial');
  child.stdin.write('ize","params":{"protocolVersion":"2024-11-05"}}\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'file.txt' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'file.txt' } } }) + '\n');
  await complete; child.stdin.end(); expect(values[3].error.message).toBe('Smart operation denied');
  expect(values[0].result.capabilities.tools).toEqual({}); expect(values[1].result.tools.map((t: any) => t.name)).toContain('permission'); expect(forwarded).toBe(1); expect(values[2].result.content[0].text).toBe('fixture contents');
});

it('diagnoses native authentication/policy through CLI without inference or an API key', async () => {
  const f = await fixture('ok', 'codex'); const { subscriptionTemplate } = await import('../src/config.js');
  const { fileURLToPath } = await import('node:url'); const { createRequire } = await import('node:module');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const config = subscriptionTemplate(); config.destinations = [f.destination];
  const path = join(f.root, 'config.json'); await writeFile(path, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--backends', '--config', path], { cwd: f.root, env: subscriptionEnvironment() });
  expect(JSON.parse(stdout)[0]).toMatchObject({ authenticated: false, policyEnforced: false, reason: 'CODEX_MODEL_NOT_AVAILABLE' });
  expect(await readFile(f.log, 'utf8')).not.toContain('turn/start');
});
