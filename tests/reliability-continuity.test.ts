import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContinuityController } from '../src/continuity.js';
import { CodexBackend, ClaudeBackend } from '../src/native-backends.js';
import { subscriptionTemplate } from '../src/config.js';
import { Store } from '../src/state.js';
import { evaluate, fixtureFiles, type ReliabilityCase } from '../src/reliability.js';
const exec = promisify(execFile);
it.each([['codex', 'claude'], ['claude', 'codex']] as const)('completes %s -> %s through native subprocess contracts and an independent judge', async (first, second) => {
  const root = await mkdtemp(join(tmpdir(), 'smart-process-continuity-')), project = join(root, 'project'), state = join(root, 'state'), home = join(root, 'codex');
  const previous = process.env.CODEX_HOME;
  const c: ReliabilityCase = { id: 'sum', project: 'sum-fixture', name: 'sum', prompt: 'Implement sum', baseline: 'export function sum(a,b){return 0;}', reference: 'export function sum(a,b){return a+b;}', mutants: [], checks: [{ args: [1, 2], expected: 3 }, { args: [-5, 2], expected: -3 }, { args: [0, 8], expected: 8 }] };
  try {
    await mkdir(project); await mkdir(home); process.env.CODEX_HOME = home;
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'sonnet', context_window: 200000 }] }));
    for (const [name, text] of Object.entries(fixtureFiles(c))) await writeFile(join(project, name), text);
    await exec('git', ['init', project]); await exec('git', ['-C', project, 'add', '.']); await exec('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-m', 'Fixture']);
    const config = subscriptionTemplate(); config.limits.maxCostUsd = 0;
    for (const provider of [first, second]) {
      const path = join(root, provider + '.mjs');
      await writeFile(path, `#!/usr/bin/env node
import fs from 'node:fs/promises';import {createInterface} from 'node:readline';
const args=process.argv.slice(2),provider=${JSON.stringify(provider)},first=${JSON.stringify(first)},root=${JSON.stringify(root)},project=${JSON.stringify(project)},source=${JSON.stringify(c.reference)};
const features=['shell_tool','hooks','plugins','apps','view_image','multi_agent_v2'];
if(args[0]==='--version'){console.log(provider==='codex'?'codex-cli 0.163.0-alpha.10.2':'2.1.303 (Claude Code)');process.exit(0);}
if(args[0]==='features'){console.log(features.map(f=>f+' stable true').join('\\n'));process.exit(0);}
if(args[0]==='plugin'){console.log('[]');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
const log=async(value)=>fs.appendFile(root+'/operations.jsonl',JSON.stringify({provider,...value})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
if(provider==='claude'){
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
 const stage=prompt.match(/CURRENT STAGE: (\\w+)/)?.[1],session=args.at(-1);await log({stage});
 send({type:'system',subtype:'init',model:'sonnet',plugins:[],tools:['mcp__smart__read_file','mcp__smart__write_file','mcp__smart__run_command','mcp__smart__permission']});
 if(provider===first&&stage==='validate'){send({type:'rate_limit_event',session_id:session,rate_limit_info:{status:'rejected',errorCode:'credits_required'}});process.exit(0);}
 const cfg=JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.smart,url=cfg.args.at(-2),token=cfg.args.at(-1);
 const call=async(name,input)=>{await log({tool:name});return (await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({name,arguments:input})})).json();};
 if(stage==='implement')await call('write_file',{path:'index.mjs',content:source});
 if(stage==='implement'||stage==='validate')await call('run_command',{command:'npm test'});
 send({type:'result',is_error:false,result:'Verified fixture',usage:{input_tokens:1,output_tokens:1}});
}else{
 const options=Object.fromEntries(args.flatMap((a,i)=>a==='-c'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));let phase=0,stage,quota=false,pending,callSeq=0;const turn='fixture-turn';
 const result=(id,r)=>send({id,result:r});
 const complete=()=>{send({method:'item/completed',params:{threadId:'fixture-session',turnId:turn,item:{id:'message',type:'agentMessage',text:'Verified fixture'}}});send({method:'turn/completed',params:{threadId:'fixture-session',turn:{id:turn,status:quota?'failed':'completed',...(quota?{error:{codexErrorInfo:'usageLimitExceeded'}}:{})}}});};
 const call=async()=>{pending='call-'+(++callSeq);const write=stage==='implement'&&phase===0,tool=write?'write_file':'run_command';await log({tool});send({id:pending,method:'item/tool/call',params:{threadId:'fixture-session',turnId:turn,callId:pending,tool:'smart_'+tool,arguments:write?{path:'index.mjs',content:source}:{command:'npm test'}}});};
 for await(const line of createInterface({input:process.stdin})){
  const m=JSON.parse(line);if(!m.method){if(m.id===pending){phase++;if(stage==='implement'&&phase===1)await call();else complete();}continue;}if(m.id===undefined)continue;
  if(m.method==='initialize')result(m.id,{});
  else if(m.method==='account/read')result(m.id,{account:{type:'chatgpt'}});
  else if(m.method==='account/rateLimits/read')result(m.id,{rateLimits:{primary:{usedPercent:10}}});
  else if(m.method==='model/list')result(m.id,{data:[{model:'sonnet'}],nextCursor:null});
  else if(m.method==='config/read')result(m.id,{config:{model_catalog_json:options.model_catalog_json?JSON.parse(options.model_catalog_json):null,model_provider:JSON.parse(options.model_provider),agents:{enabled:false},web_search:'disabled',features:Object.fromEntries(features.map(f=>[f,false])),notify:[],mcp_servers:{}},layers:[{name:{type:'sessionFlags'},config:{tools:{update_plan:{enabled:false},experimental_request_user_input:{enabled:false}}}}]});
  else if(m.method==='thread/start'||m.method==='thread/read'||m.method==='thread/resume')result(m.id,{thread:{id:'fixture-session',cwd:project,status:{type:'idle'}}});
  else if(m.method==='mcpServerStatus/list')result(m.id,{data:[],nextCursor:null});
  else if(m.method==='turn/start'){
   phase=0;stage=m.params.input[0].text.match(/CURRENT STAGE: (\\w+)/)?.[1];quota=provider===first&&stage==='validate';await log({stage});result(m.id,{turn:{id:turn}});send({method:'turn/started',params:{threadId:'fixture-session',turn:{id:turn}}});if(quota||!['implement','validate'].includes(stage))complete();else await call();
  }else result(m.id,{});
 }
}
`, { mode: 0o700 });
    }
    config.destinations = [first, second].map(backend => ({ id: backend, backend, billing: 'subscription', models: { fast: 'sonnet', balanced: 'sonnet', deep: 'sonnet' }, executable: join(root, backend + '.mjs') }));
    const approvals: string[] = [];
    const controller = new ContinuityController(async d => d.backend === 'codex' ? new CodexBackend(d, project, async text => { approvals.push(text); return true; }) : new ClaudeBackend(d, project, async text => { approvals.push(text); return true; }), config, new Store(state), () => {});
    const task = await controller.run(c.prompt, project);
    expect(task.status).toBe('completed'); expect(task.calls).toBe(4); expect(task.activeDestination).toBe(second); expect(task.exhausted).toContain(first);
    expect(task.transitions.map(t => t.to)).toEqual([first, second]); expect(task.transitions.every(t => t.state === 'committed')).toBe(true);
    expect(approvals).toHaveLength(3); expect(task.spent).toBe(0); expect(task.unknownCost).toBe(false);
    const operations = (await readFile(join(root, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(operations.filter(x => x.tool === 'write_file')).toHaveLength(1); expect(operations.filter(x => x.tool === 'run_command')).toHaveLength(2);
    expect(await evaluate(c, await readFile(join(project, 'index.mjs'), 'utf8'))).toBe(true);
    expect(await readFile(join(project, 'USER-NOTE.txt'), 'utf8')).toBe(fixtureFiles(c)['USER-NOTE.txt']);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; await rm(root, { recursive: true, force: true }); }
}, 20000);
