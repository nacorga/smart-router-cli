import {smokeConfig,writeSmokeProvider} from './smoke-fixture.js';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,mkdir,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './state.js';
async function main(){
  const router=process.cwd();
  const root=await realpath(await mkdtemp(join(tmpdir(),'smart-cli-smoke-')));
  const env:NodeJS.ProcessEnv & {SMART_STATE_DIR:string}={...process.env,OPENROUTER_API_KEY:'local-cli-smoke-only',SMART_STATE_DIR:join(root,'state')};
  for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){const path=join(root,name.toLowerCase());await mkdir(path);env[name]=path;}
  let requests=0;const models:string[]=[];
  let nextGate:{entered:()=>void;wait:Promise<void>}|undefined;
  const gateNext=()=>{let enteredFlag=false;let release!:()=>void;const entered=()=>{enteredFlag=true;};const wait=new Promise<void>(r=>{release=r;});nextGate={entered,wait};return{entered:()=>enteredFlag,release};};
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.url,'/chat/completions');assert.equal(req.headers.authorization,'Bearer local-cli-smoke-only');
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());requests++;models.push(body.model);
      const gate=nextGate;nextGate=undefined;if(gate){gate.entered();await gate.wait;}if(res.destroyed)return;
      const base={id:`gen-local-cli-${requests}`,object:'chat.completion.chunk',created:1,model:body.model};
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Local simulated response.'},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\n`);res.end('data: [DONE]\n\n');
    }catch{res.writeHead(500).end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No address');
  const config=smokeConfig();config.mode='auto';config.limits.maxCostUsd=0.1;
  await writeFile(join(root,'smart-router.config.json'),JSON.stringify(config));
  await writeSmokeProvider(root,`http://127.0.0.1:${address.port}`);
  const child:ChildProcessWithoutNullStreams=spawn(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url))],{cwd:root,env,stdio:'pipe'});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const done=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  const waitFor=async(check:()=>boolean)=>{const end=Date.now()+60000;while(!check()){if(child.exitCode!==null)throw new Error('CLI exited before expected output');if(Date.now()>end)throw new Error('CLI smoke timed out');await new Promise(r=>setTimeout(r,25));}};
  const send=(line:string)=>{child.stdin.write(line+'\n');};
  const run=async(command:string,status:string)=>{const offset=stdout.length;send(command);await waitFor(()=>stdout.slice(offset).includes(`Result: ${status}`)&&stdout.slice(offset).includes('smart>'));};
  const store=new Store(env.SMART_STATE_DIR);
  let phase='startup';
  let watchdog:ReturnType<typeof setTimeout>|undefined;
  try{
    watchdog=setTimeout(()=>{console.error(JSON.stringify({phase,lastOutput:stdout.slice(-1200),stderr}));child.stdin.end();child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2000).unref();},60000);
    await waitFor(()=>stdout.includes('smart> /help'));
    send('/budget 0');await run('Busca el archivo de ejemplo','blocked');assert.equal(requests,0);
    send('/budget 0.1');send('/mode manual');send('/model deep');await run('Busca el archivo de ejemplo','completed');assert.equal(models.at(-1),config.models.deep.replace(/^openrouter\//,''));
    const manual=(await store.list(root))[0]!;assert.equal(manual.override,'deep');
    const statusOffset=stdout.length;send('/status');send('/history');send('/sessions');
    await waitFor(()=>stdout.slice(statusOffset).includes(manual.id)&&stdout.slice(statusOffset).includes('MANUAL_OVERRIDE'));
    assert.match(stdout.slice(statusOffset),/"budget": 0\.1/);
    send('/mode auto');await run('Busca el archivo de ejemplo','completed');assert.equal(models.at(-1),config.models.fast.replace(/^openrouter\//,''));
    const beforeResume=requests;const resumeOffset=stdout.length;send(`/resume ${manual.id}`);
    await waitFor(()=>stdout.slice(resumeOffset).includes('Session loaded for inspection'));assert.equal(requests,beforeResume);
    await run('Explica el resultado anterior','completed');const continued=(await store.list(root))[0]!;assert.equal(continued.sessionId,manual.sessionId);assert.equal(continued.override,'deep');
    const budgetGate=gateNext();send('/mode auto');send('/budget 0.1');const budgetOffset=stdout.length;send('Implementa una función de ejemplo');await waitFor(budgetGate.entered);
    const beforeBudget=requests;send('/budget 0');const budgetStatusOffset=stdout.length;send('/status');await waitFor(()=>stdout.slice(budgetStatusOffset).includes('"budget": 0'));budgetGate.release();
    await waitFor(()=>stdout.slice(budgetOffset).includes('Result: blocked')&&stdout.slice(budgetOffset).includes('smart>'));assert.equal(requests,beforeBudget);assert.equal((await store.list(root))[0]!.note,'BUDGET_OR_CALL_LIMIT');
    const cancelGate=gateNext();send('/budget 0.1');const cancelOffset=stdout.length;send('Busca el archivo de ejemplo');await waitFor(cancelGate.entered);const beforeCancel=requests;send('/cancel');
    await waitFor(()=>stdout.slice(cancelOffset).includes('Result: cancelled')&&stdout.slice(cancelOffset).includes('smart>'));cancelGate.release();assert.equal(requests,beforeCancel);assert.equal((await store.list(root))[0]!.status,'cancelled');
    phase='exit';console.log('CLI_SMOKE controls passed; waiting for exit');send('/exit');child.stdin.end();const code=await done;assert.equal(code,1);assert.equal(stderr,'');
    const report={status:'passed',sdkVersion:'1.19.3',input:'interactive command parser over pipes; not terminal keyboard rendering',projectPath:root,localMockRequests:requests,realProviderInferenceRequests:0,billableCostUsd:0,checks:{zeroBudgetPreventsInference:true,manualOverride:true,autoRestored:true,statusHistorySessions:true,resumeInspectionMakesNoRequest:true,explicitContinuationSameSession:true,activeBudgetStopsNextStage:true,cancelStopsNextStage:true,cleanExit:true}};
    await writeFile(join(root,'cli-smoke-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{if(watchdog)clearTimeout(watchdog);if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([done,new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill('SIGKILL');}server.closeAllConnections();server.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'CLI smoke failed');process.exitCode=1;});
