import {smokeConfig,writeSmokeProvider} from './smoke-fixture.js';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenCodeBackend} from './opencode.js';
async function main(){
  const router=process.cwd();const directory=await realpath(await mkdtemp(join(tmpdir(),'smart-review-smoke-')));
  for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){const path=join(directory,name.toLowerCase());await mkdir(path);process.env[name]=path;}
  process.env.OPENROUTER_API_KEY='local-smoke-only';process.chdir(directory);let localRequests=0;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.tool_choice,'auto');assert.equal(body.response_format,undefined);localRequests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const base={id:'gen-local-smoke',object:'chat.completion.chunk',created:1,model:'smart-fixture-deep'};
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'{"verdict":"passed","findings":[]}'},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No address');
  let backend:OpenCodeBackend|undefined;
  try{
    await writeSmokeProvider(directory,`http://127.0.0.1:${address.port}`);backend=await OpenCodeBackend.start(directory,async()=>false,{openrouterBaseURL:`http://127.0.0.1:${address.port}`});
    const sessionID=await backend.create();const result=await backend.prompt(sessionID,'openrouter/smart-fixture-deep','Review this fixture.','review',()=>{});
    assert.equal(result.reviewVerdict,'passed');assert.equal(localRequests,1);
    const {data:messages}=await backend.client.session.messages({sessionID,directory},{throwOnError:true});assert.equal(messages.length,2);
    const report={status:'passed',serverVersion:'1.19.3',localMockRequests:localRequests,realProviderRequests:0,billableCostUsd:0,nativeReportedCostUsd:result.usage.reduce((n,u)=>n+(u.costUsd??0),0),nativeHistoryReadable:true,reviewVerdict:result.reviewVerdict};
    await writeFile(join(directory,'review-smoke-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{await backend?.close();server.closeAllConnections();server.close();process.chdir(router);}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Review smoke failed');process.exitCode=1;});
