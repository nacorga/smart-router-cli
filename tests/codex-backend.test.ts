import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexBackend } from '../src/codex-backend.js';
import { claudeQuota } from '../src/claude-quota.js';
import { featureNames, restrictedCodexModel, verifyCodexPolicy } from '../src/codex-policy.js';
import type { Destination } from '../src/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(scenario = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'smart-codex-contract-')), executable = join(root, 'codex.mjs'), home = join(root, 'home'); await mkdir(home);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  cleanup.push(async () => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; await rm(root, { recursive: true, force: true }); });
  await writeFile(join(home, 'models_cache.json'), JSON.stringify({ identity: { private: 'not-model-metadata' }, models: [{ slug: 'fixture-model', context_window: 200000 }] }));
  await writeFile(join(root, 'value.txt'), 'prior');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';import fs from 'node:fs/promises';
const args=process.argv.slice(2),scenario=${JSON.stringify(scenario)},root=${JSON.stringify(root)};
if(args[0]==='--version'){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0);}
const features=['shell_tool','hooks','plugins','apps','view_image','multi_agent_v2'];
if(args[0]==='features'){console.log(features.map(f=>f+' stable true').join('\\n'));process.exit(0);}
const options=Object.fromEntries(args.flatMap((a,i)=>a==='-c'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n'),result=(id,value)=>send({id,result:value});
let turn='fixture-turn',pending,phase=0,tools=0;
const complete=()=>{const boundary=['final-boundary','over-boundary','tools-after-final'].includes(scenario);
 send({method:'item/completed',params:{threadId:'fixture-session',turnId:turn,item:{id:'message',type:'agentMessage',text:'Done',...(boundary?{phase:'final_answer'}:{})}}});
 for(let i=0;i<(scenario==='over-boundary'?9:boundary?8:1);i++)send({method:'thread/tokenUsage/updated',params:{threadId:'fixture-session',turnId:turn,tokenUsage:{last:{inputTokens:2+i,outputTokens:1}}}});
 if(scenario==='tools-after-final'){phase=0;call();return;}
 const finish=()=>send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:turn,status:scenario==='quota'||scenario==='quota-after'||scenario==='rate'?'failed':'completed',error:{codexErrorInfo:scenario==='rate'?'rateLimitExceeded':'usageLimitExceeded'}}}});
 if(boundary)setTimeout(finish,30);else finish();};
const call=()=>{pending='tool-'+(++tools);send({id:pending,method:'item/tool/call',params:{threadId:'fixture-session',turnId:turn,callId:pending,tool:phase===0?'smart_write_file':'smart_run_command',arguments:phase===0?{path:'value.txt',content:'preserved'}:{command:'npm test'}}});};
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(!m.method){if(m.id===pending){phase++;if(phase===1&&scenario!=='quota-after')call();else complete();}continue;}
 await fs.appendFile(root+'/methods.jsonl',JSON.stringify({method:m.method})+'\\n');if(m.id===undefined)continue;
 if(m.method==='initialize')result(m.id,{});
 else if(m.method==='account/read')result(m.id,{account:{type:scenario==='api'?'apiKey':'chatgpt'}});
 else if(m.method==='account/rateLimits/read')result(m.id,{rateLimits:{primary:{usedPercent:scenario==='exhausted'?100:30,resetsAt:2000000000}}});
 else if(m.method==='model/list')result(m.id,{data:[{model:'fixture-model',hidden:false}],nextCursor:null});
 else if(m.method==='config/read')result(m.id,{config:{model_catalog_json:options.model_catalog_json?JSON.parse(options.model_catalog_json):null,model_provider:JSON.parse(options.model_provider),agents:{enabled:scenario==='policy'},web_search:'disabled',features:Object.fromEntries(features.map(f=>[f,false])),notify:[],mcp_servers:{}},layers:[{name:{type:'sessionFlags'},config:{tools:{update_plan:{enabled:false},experimental_request_user_input:{enabled:false}}}}]});
 else if(m.method==='thread/start'||m.method==='thread/read'||m.method==='thread/resume')result(m.id,{thread:{id:'fixture-session',cwd:root,status:{type:'idle'}}});
 else if(m.method==='mcpServerStatus/list')result(m.id,{data:scenario==='mcp'?[{name:'foreign'}]:scenario==='disabled-mcp'?[{runtimeStatus:'disabled',serverInfo:null,serverCapabilities:null,tools:{},resources:[],resourceTemplates:[]}]:[],nextCursor:null});
 else if(m.method==='turn/start'){result(m.id,{turn:{id:turn}});send({method:'turn/started',params:{threadId:'fixture-session',turn:{id:turn}}});if(scenario==='lost')process.exit(1);else if(scenario==='truncated'){process.stdout.write('{"unfinished":');process.exit(0);}else if(scenario==='wait'){}else if(scenario==='quota'||scenario==='rate')complete();else call();}
 else if(m.method==='turn/interrupt'){result(m.id,{});send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:turn,status:'interrupted'}}});}
 else result(m.id,{});
}
`, { mode: 0o700 });
  const destination: Destination = { id: 'codex-fixture', backend: 'codex', billing: 'subscription', executable, models: { fast: 'fixture-model', balanced: 'fixture-model', deep: 'fixture-model' } };
  const approvals: string[] = []; const backend = new CodexBackend(destination, root, async description => { approvals.push(description); return scenario !== 'denied'; }); cleanup.unshift(() => backend.close());
  return { root, backend, approvals };
}
describe('Codex native contract with deterministic subprocess', () => {
  it('enforces a restricted profile and executes only approved operations with real exit evidence', async () => {
    const { root, backend } = await fixture(); expect(await backend.probe()).toMatchObject({ authenticated: true, policyEnforced: true });
    const session = await backend.create(); await backend.prepare(session);
    const result = await backend.prompt(session, 'fixture-model', 'Implement', 'implement', () => {});
    expect(result.failure).toBeUndefined(); expect(result.validation).toBe('passed'); expect(result.toolsExecuted).toBe(true); expect(result.usage).toHaveLength(1);
    expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('preserved'); expect(result.evidence).toHaveLength(1);
  });
  it.each(['api', 'policy'])('blocks %s before inference', async scenario => {
    const { root, backend } = await fixture(scenario); const probe = await backend.probe(); expect(probe.authenticated && probe.policyEnforced).toBe(false);
    expect(await readFile(join(root, 'methods.jsonl'), 'utf8')).not.toContain('turn/start'); await expect(backend.create()).rejects.toThrow('POLICY');
  });
  it('accepts explicitly disabled MCP inventory with no live capabilities', async () => { const { backend } = await fixture('disabled-mcp'); await backend.probe(); expect(await backend.create()).toBe('fixture-session'); });
  it('rejects foreign MCP servers before inference', async () => { const { backend } = await fixture('mcp'); await backend.probe(); await expect(backend.create()).rejects.toThrow('MCP'); });
  it.each(['quota', 'quota-after', 'rate'])('classifies %s without authorizing unsafe replay', async scenario => {
    const { backend } = await fixture(scenario); await backend.probe(); const result = await backend.prompt(await backend.create(), 'fixture-model', 'Task', 'implement', () => {});
    expect(result.failure).toBe(scenario === 'rate' ? 'infrastructure' : 'quota'); expect(result.rejectedBeforeTools).toBe(scenario === 'quota'); expect(result.toolsExecuted).toBe(scenario === 'quota-after');
  });
  it('lets a final answer finish at the eighth model step without interrupting it', async () => {
    const { backend, root } = await fixture('final-boundary'); await backend.probe();
    const result = await backend.prompt(await backend.create(), 'fixture-model', 'Task', 'implement', () => {});
    expect(result.failure).toBeUndefined(); expect(result.validation).toBe('passed'); expect(result.usage).toHaveLength(8);
    expect(await readFile(join(root, 'methods.jsonl'), 'utf8')).not.toContain('turn/interrupt');
  });
  it.each(['over-boundary', 'tools-after-final'])('still enforces the step budget for %s', async scenario => {
    const { backend, approvals } = await fixture(scenario); await backend.probe();
    const result = await backend.prompt(await backend.create(), 'fixture-model', 'Task', 'implement', () => {});
    expect(result.failure).toBe('limit'); expect(approvals).toHaveLength(2);
  });
  it('keeps permission failures separate from quota', async () => { const { backend, root } = await fixture('denied'); await backend.probe(); const result = await backend.prompt(await backend.create(), 'fixture-model', 'Task', 'implement', () => {}); expect(result.failure).toBe('permission'); expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('prior'); });
  it.each(['lost', 'truncated'])('blocks a %s native stream', async scenario => { const { backend } = await fixture(scenario); await backend.probe(); await expect(backend.prompt(await backend.create(), 'fixture-model', 'Task', 'implement', () => {})).rejects.toThrow(); });
  it('cancels and closes its own process before returning', async () => {
    const { backend } = await fixture('wait'); await backend.probe(); const session = await backend.create();
    const pending = backend.prompt(session, 'fixture-model', 'Task', 'implement', () => {}).catch(() => undefined);
    await new Promise(r => setTimeout(r, 100)); await backend.abort(session); const result = await pending; expect(result?.failure ?? 'uncertain').toBe('uncertain'); await expect(backend.create()).rejects.toThrow();
  });
});
it('never copies cache identity or enables native tools in restricted metadata', () => {
  const model = restrictedCodexModel({ slug: 'fixture', context_window: 1000, identity: 'private', shell_type: 'shell_command', experimental_supported_tools: ['shell'] });
  expect(model).not.toHaveProperty('identity'); expect(model.shell_type).toBe('disabled'); expect(model.experimental_supported_tools).toEqual([]);
  expect(() => featureNames('shell_tool stable true')).toThrow('CONTRACT'); expect(verifyCodexPolicy({}, [], '', '')).toBe(false);
});
it('binds Claude quota evidence to its session and documented error', () => {
  const event = { type: 'rate_limit_event', session_id: 'fixture', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } };
  expect(claudeQuota(event, 'other')).toBeUndefined(); expect(claudeQuota(event, 'fixture')?.state).toBe('exhausted');
  expect(claudeQuota({ ...event, rate_limit_info: { status: 'rejected' } }, 'fixture')).toBeUndefined();
  expect(claudeQuota({ ...event, rate_limit_info: { status: 'allowed_warning' } }, 'fixture')?.state).toBe('available');
});
