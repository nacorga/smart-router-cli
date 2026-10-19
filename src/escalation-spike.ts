import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, requireConfigured } from './config.js';
import { loadLocalEnv } from './env.js';
import { Controller } from './controller.js';
import { OpenCodeBackend } from './opencode.js';
import { Store } from './state.js';
import type { Backend, StageKind } from './types.js';
const exec = promisify(execFile);
const broken = 'export function add(a, b) { return a - b; }\n';
const tests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './sum.mjs';
test('adds positive integers', () => assert.equal(add(2, 3), 5));
test('adds signed integers', () => assert.equal(add(-2, 7), 5));
test('adds zero', () => assert.equal(add(0, 1), 1));
`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Paid escalation test with controlled fault injection in a temporary fixture. Use --run. It does not measure relative model ability.'); return;
  }
  const router = process.cwd();
  const config = await loadConfig(router); requireConfigured(config); await loadLocalEnv(router);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');
  const project = await realpath(await mkdtemp(join(tmpdir(), 'smart-escalation-')));
  await mkdir(join(router,'artifacts'),{recursive:true});
  const reportPath = resolve(router, 'artifacts/ESCALATION-RESULT.json');
  const report: Record<string, unknown> = { date:new Date().toISOString().slice(0,10), status:'running', fixtureKind:'controlled-fault-injection', projectPath:project, budgetUsd:config.limits.maxCostUsd, models:config.models, injectedFaults:0, validations:[], permissions:[] };
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  const save = () => writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const target = join(project,'sum.mjs');
  const packageSource = JSON.stringify({type:'module',scripts:{test:'node --test sum.test.mjs'}});
  await writeFile(target,broken); await writeFile(join(project,'sum.test.mjs'),tests); await writeFile(join(project,'package.json'),packageSource);
  await writeFile(join(project,'original.txt'),'PRESERVE_EXISTING_CONTENT\n');
  try { await exec('npm',['test'],{cwd:project,timeout:15000}); throw new Error('FIXTURE_DID_NOT_FAIL'); }
  catch (error) { if ((error as {code?:number}).code !== 1) throw error; report.baseline='failed with exit 1'; }
  for (const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']) {
    const path = join(project,name.toLowerCase()); await mkdir(path); process.env[name]=path;
  }
  process.chdir(project);
  let activeStage: StageKind = 'explore'; let activeModel=''; let validationAttempt=0; let testsThisPrompt=0; let editsThisPrompt=0;
  const validations: Record<string,unknown>[] = []; const permissionEvents: {permission:string;approved:boolean}[]=[];
  const approve = async (description: string) => {
    const i=description.indexOf('\n'); const header=description.slice(0,i); const metadata=JSON.parse(description.slice(i+1));
    const edit=header.startsWith('edit: ') && header.slice(6).split(', ').every(p=>resolve(project,p)===target || resolve('/',p)===target);
    const test=header.startsWith('bash: ') && metadata.command==='npm test' && testsThisPrompt===0;
    if (edit) editsThisPrompt++;
    if (test) {
      testsThisPrompt++;
      if (activeStage==='validate' && activeModel===config.models.balanced && validationAttempt<=2) {
        const sourceBefore=await readFile(target,'utf8');
        await writeFile(target,broken);
        report.injectedFaults=Number(report.injectedFaults)+1;
        console.log(`FAULT_INJECTED validate attempt ${validationAttempt}; prior source ${hash(sourceBefore).slice(0,12)}`);
      }
    }
    const approved=edit||test; permissionEvents.push({permission:header,approved}); console.log(`${approved?'APPROVED':'REJECTED'} ${header}`); return approved;
  };
  let native: OpenCodeBackend | undefined; let controller: Controller | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    native=await OpenCodeBackend.start(project,approve);
    const real=native;
    const backend: Backend = {
      catalog:()=>real.catalog(), create:()=>real.create(), prepare:id=>real.prepare(id), abort:id=>real.abort(id), close:()=>real.close(),
      prompt:async (id,model,prompt,stage,onText)=>{
        activeStage=stage; activeModel=model; testsThisPrompt=0; editsThisPrompt=0;
        if(stage==='validate') validationAttempt++;
        const protocol=stage==='validate'
          ? '\nTEST PROTOCOL: Run npm test EXACTLY ONCE in this request. If the previous HANDOFF says validation failed, first repair sum.mjs with edit, then run npm test once. If that run fails, report the failure and STOP immediately: the controller schedules any next repair. Do not repair or rerun again in this request.'
          : '';
        const result=await real.prompt(id,model,prompt+protocol,stage,onText);
        if(stage==='validate') {
          validations.push({attempt:validationAttempt,model,validation:result.validation,failure:result.failure,evidence:result.evidence,edits:editsThisPrompt,testCommands:testsThisPrompt});
          report.validations=validations; await save();
          console.log(`VALIDATION_RESULT attempt ${validationAttempt}: ${result.validation}; edits=${editsThisPrompt}`);
        }
        // Return the real result unchanged: no manufactured failures or success signals.
        return result;
      },
    };
    controller=new Controller(backend,config,new Store(join(project,'smart-state')),s=>{if(/^\[(?:FAST|BALANCED|DEEP)\]|^Result:|^Bounded repair/.test(s)) console.log(s);});
    watchdog=setTimeout(()=>{void controller!.cancel().catch(()=>false);},180000);
    const task=await controller.run('Implementa la suma aritmética add(a,b) en sum.mjs para que pasen los tres tests existentes. Solo edita sum.mjs con edit. Conserva sum.test.mjs, package.json y original.txt. Explora usando read, sin shell. En implementación corrige la función y puedes ejecutar npm test una vez. En validación ejecuta npm test exactamente una vez por petición; si el HANDOFF previo contiene un fallo, primero corrige sum.mjs con edit y después ejecuta los tests una vez. Si fallan, informa del resultado y termina esta petición sin otra reparación: el controlador decide el siguiente intento. No ejecutes otros comandos. No cambies tests ni scripts.',project);
    report.task=task; report.reportedCostUsd=task.spent; report.unknownCost=task.unknownCost; await save();
    assert.equal(task.status,'completed'); assert.equal(task.unknownCost,false);
    assert.equal(report.injectedFaults,2); assert.equal(validations.length,3);
    assert.deepEqual(validations.map(v=>v.model),[config.models.balanced,config.models.balanced,config.models.deep]);
    assert.deepEqual(validations.map(v=>v.validation),['failed','failed','passed']);
    assert.ok(Number(validations[1]!.edits)>0,'No actual Balanced repair was attempted');
    assert.ok(Number(validations[2]!.edits)>0,'Deep did not repair the injected defect');
    assert.deepEqual(validations[0]!.evidence,validations[1]!.evidence,'Failure was not reproducible');
    assert.equal(await readFile(join(project,'sum.test.mjs'),'utf8'),tests); assert.equal(await readFile(join(project,'package.json'),'utf8'),packageSource);
    assert.equal(await readFile(join(project,'original.txt'),'utf8'),'PRESERVE_EXISTING_CONTENT\n');
    await exec('npm',['test'],{cwd:project,timeout:15000});
    const decision=task.stages.find(s=>s.kind==='validate')!.decisions.at(-1)!;
    assert.ok(decision.reasonCodes.includes('REPRODUCIBLE_VALIDATION_FAILURE'));
    report.independentTests={passed:3,failed:0,exitCode:0}; report.testsUnmodified=true; report.previousFilePreserved=true;
    report.status='passed'; report.interpretation='The harness injected the same real defect before both Balanced validation runs. Deep repaired it after injection stopped. This tests routing and repair mechanics, not relative model ability.';
  } catch(error) { report.status='failed'; report.failure=error instanceof Error?error.message:'UNKNOWN_FAILURE'; throw error; }
  finally {
    if(watchdog)clearTimeout(watchdog); await native?.close(); process.chdir(router); report.permissions=permissionEvents; await save();
    console.log(JSON.stringify({status:report.status,reportPath,projectPath:project,reportedCostUsd:report.reportedCostUsd,unknownCost:report.unknownCost}));
  }
}
if(process.argv[1] && /escalation-spike\.(?:ts|js)$/.test(process.argv[1])) main().catch(error=>{console.error(error instanceof Error?error.message:'Escalation test failed');process.exitCode=1;});
