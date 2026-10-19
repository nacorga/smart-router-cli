import {writeSmokeProvider} from '../dist/smoke-fixture.js';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {OpenCodeBackend} from '../dist/opencode.js';
import {Controller} from '../dist/controller.js';
import {Store} from '../dist/state.js';
import {defaults} from '../dist/config.js';
import {validationCommandPolicy} from '../dist/safety.js';
import {pilotPermission} from './scoped-permission.mjs';
const router=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=await realpath(await mkdtemp(join(tmpdir(),'smart-validation-contract-'))),project=join(root,'project');
await mkdir(project);
for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){process.env[name]=join(root,name.toLowerCase());await mkdir(process.env[name]);}
process.env.OPENROUTER_API_KEY='local-validation-contract-only';
const commands=['npm run test:unit -- fixture.test.ts','npm run type-check','npm run check'];
await writeFile(join(project,'package.json'),JSON.stringify({private:true,type:'module',scripts:{'test:unit':'node validate.mjs test','type-check':'node validate.mjs type',check:'node validate.mjs check'}}));
await writeFile(join(project,'sentinel.txt'),'UNCHANGED');
await writeFile(join(project,'validate.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(fs.readFileSync('sentinel.txt','utf8'),'UNCHANGED');fs.appendFileSync('executed.txt',process.argv[2]+'\\n');if(process.argv[2]==='check'&&fs.existsSync('fail-check'))process.exitCode=1;`);
let scenario,requests=0;const approvals=[],scenarios=[];let backend;
const server=createServer((req,res)=>{void(async()=>{
 assert.equal(req.url,'/chat/completions');assert.equal(req.headers.authorization,'Bearer local-validation-contract-only');
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests++;
 assert.ok(JSON.stringify(body.messages).includes(validationCommandPolicy),'Native provider did not receive command contract');
 const lastUser=body.messages.findLast(m=>m.role==='user');const tools=body.messages.slice(body.messages.lastIndexOf(lastUser)+1).some(m=>m.role==='tool');
 const text=JSON.stringify(lastUser?.content);const validate=scenario.direct||text.includes('CURRENT STAGE: validate.');
 const call=validate&&!tools;
 const delta=call?{role:'assistant',tool_calls:scenario.commands.map((command,index)=>({index,id:'call-'+requests+'-'+index,type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Run the exact validation command',workdir:project})}}))}:{role:'assistant',content:'Local scripted response; validation is determined by native tool metadata.'};
 const base={id:'gen-local-validation-'+requests,object:'chat.completion.chunk',created:1,model:body.model};res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\n');res.end('data: [DONE]\n\n');
})().catch(error=>{console.error(error.message);res.destroy(error);});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const model='openrouter/smart-fixture-deep';
await writeSmokeProvider(project,'http://127.0.0.1:'+server.address().port);
try{
 backend=await OpenCodeBackend.start(project,async description=>{const approved=pilotPermission(project,[],commands,description);approvals.push({description,approved});return approved;},{openrouterBaseURL:'http://127.0.0.1:'+server.address().port});
 // The fixture has a local catalog and local zero-cost accounting; native sessions and bash tools are real.
 const wrapped={catalog:async()=>[{id:model,tools:true,context:200000,inputPrice:0,outputPrice:0}],create:()=>backend.create(),abort:id=>backend.abort(id),close:()=>backend.close(),prompt:async(...args)=>{const r=await backend.prompt(...args);return {...r,usage:r.usage.map(u=>({...u,costUsd:0,source:'local'}))};}};
 const config=structuredClone(defaults);config.models={fast:model,balanced:model,deep:model};
 scenario={commands,direct:false};let offset=approvals.length;
 const controller=new Controller(wrapped,config,new Store(join(root,'state')),()=>{});
 const task=await controller.run('Implementa la validación del ejemplo y ejecuta los tres comandos indicados.',project);
 assert.equal(task.status,'completed');assert.equal(task.stages.find(s=>s.kind==='validate').attempts.at(-1).evidence.length,3);assert.ok(approvals.slice(offset).every(p=>p.approved));
 const firstLog=await readFile(join(project,'executed.txt'),'utf8');assert.deepEqual(firstLog.trim().split('\n').sort(),['check','test','type']);
 scenarios.push({name:'exact commands through controller and native tools',status:task.status,validationEvidence:task.stages.at(-1).attempts.at(-1).evidence});
 await writeFile(join(project,'fail-check'),'1');scenario={commands:['npm run check'],direct:true};offset=approvals.length;
 const failed=await backend.prompt(await backend.create(),model,'Run npm run check exactly.','validate',()=>{});assert.equal(failed.validation,'failed');assert.equal(failed.failure,undefined);assert.ok(approvals.slice(offset).every(p=>p.approved));
 scenarios.push({name:'check failure from native exit metadata',validation:failed.validation,evidence:failed.evidence});
 const logBefore=await readFile(join(project,'executed.txt'),'utf8');
 const rejected=['npm run test:unit -- fixture.test.ts; echo "EXIT=$?"','npm run check > /dev/null 2>&1; echo "exit=$?"','npm run type-check > /dev/null 2>&1; echo "exit=$?"'];
 for(const command of rejected){scenario={commands:[command],direct:true};offset=approvals.length;const result=await backend.prompt(await backend.create(),model,'Run the supplied validation.','validate',()=>{});assert.equal(result.failure,'permission');assert.equal(result.validation,'none');assert.ok(approvals.slice(offset).length>0);assert.ok(approvals.slice(offset).every(p=>!p.approved));scenarios.push({name:'historical shell wrapper remains denied',command,failure:result.failure,validation:result.validation});}
 assert.equal(await readFile(join(project,'executed.txt'),'utf8'),logBefore);assert.equal(await readFile(join(project,'sentinel.txt'),'utf8'),'UNCHANGED');
 const report={status:'passed',createdAt:new Date().toISOString(),sdkVersion:'1.19.3',project,localMockRequests:requests,realProviderInferenceRequests:0,billableCostUsd:0,policySha256:createHash('sha256').update(validationCommandPolicy).digest('hex'),scenarios,approvals,limitations:'Scripted local provider proves native tool, permission and metadata integration; it does not establish paid-model adherence to the new prompt. Historical measured scores unchanged.'};await writeFile(join(root,'validation-contract-smoke-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,localMockRequests:requests,scenarios:scenarios.length,billableCostUsd:0}));
}finally{await backend?.close();server.closeAllConnections();server.close();}
