import {smokeConfig,writeSmokeProvider} from './smoke-fixture.js';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OpenCodeBackend} from './opencode.js';
async function main(){
  const router=process.cwd();const root=await realpath(await mkdtemp(join(tmpdir(),'smart-control-tools-')));const project=join(root,'project');await mkdir(project);await writeFile(join(project,'sentinel.txt'),'UNCHANGED');
  for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){const path=join(root,name.toLowerCase());await mkdir(path);process.env[name]=path;}
  process.env.OPENROUTER_API_KEY='local-control-smoke-only';let requests=0;let approvals=0;const offered:string[][]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());requests++;offered.push((body.tools??[]).map((t:{function:{name:string}})=>t.function.name));
    const base={id:`gen-local-control-${requests}`,object:'chat.completion.chunk',created:1,model:body.model};res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Progress is reported in text; no tools executed.'},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\n`);res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('No address');let backend:OpenCodeBackend|undefined;
  try{
    process.chdir(project);await writeSmokeProvider(project,`http://127.0.0.1:${address.port}`);backend=await OpenCodeBackend.start(project,async()=>{approvals++;return false;},{openrouterBaseURL:`http://127.0.0.1:${address.port}`});
    for(const stage of ['implement','explore'] as const){const id=await backend.create();const result=await backend.prompt(id,'openrouter/smart-fixture-deep','Describe progress only; no edits or commands are needed.',stage,()=>{});assert.equal(result.failure,undefined);}
    assert.equal(requests,2);assert.equal(approvals,0);
    for(const names of offered)for(const forbidden of ['todowrite','todoread','question','task'])assert.ok(!names.includes(forbidden),`${forbidden} exposed to model`);
    assert.ok(offered[0]!.includes('edit'));assert.ok(offered[0]!.includes('bash'));assert.ok(!offered[1]!.includes('edit'));assert.ok(!offered[1]!.includes('bash'));assert.equal(await readFile(join(project,'sentinel.txt'),'utf8'),'UNCHANGED');
    const report={status:'passed',sdkVersion:'1.19.3',localMockRequests:requests,realProviderInferenceRequests:0,billableCostUsd:0,nativeControlToolsHidden:true,implementationEditAndBashStillRequirePermission:true,readOnlyEditAndBashHidden:true,projectSentinelPreserved:true,note:'Local scripted provider; no real-model adherence claim.'};
    await writeFile(join(root,'control-tools-smoke-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{await backend?.close();server.closeAllConnections();server.close();process.chdir(router);}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Control tool smoke failed');process.exitCode=1;});
