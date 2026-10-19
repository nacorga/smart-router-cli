import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { aggregate, pairedMetrics, stratifiedOrder, fixturePermission, sourceFor, testFor, type BenchmarkCase, type BenchmarkRow } from '../src/benchmark.js';
describe('benchmark', () => {
  it('contains the prescribed 20 case distribution', async () => {
    const cases: BenchmarkCase[] = JSON.parse(await readFile(new URL('../benchmark/cases.json', import.meta.url), 'utf8'));
    expect(cases).toHaveLength(20);
    expect(Object.fromEntries(['trivial','usual','complex','sensitive'].map(k => [k,cases.filter(c => c.category === k).length]))).toEqual({trivial:5,usual:7,complex:5,sensitive:3});
    for (const c of cases) { expect(sourceFor(c)).toContain(c.name); expect(testFor(c)).toContain('input must be preserved'); expect(c.checks.length).toBeGreaterThan(1); }
  });
  it('includes failed task costs in cost per completion', () => {
    const r = aggregate([{ arm:'smart',passed:true,cost:1,unknownCost:false },{arm:'smart',passed:false,cost:1,unknownCost:false},{arm:'deep-only',passed:true,cost:4,unknownCost:false}]);
    expect(r.costReductionPerCompletedTask).toBe(0.5); expect(r.qualityRatio).toBe(1);
  });
  it('never fabricates savings with incomplete costs or no baseline', () => { expect(aggregate([]).costReductionPerCompletedTask).toBeNull(); expect(aggregate([{arm:'smart',passed:true,cost:0,unknownCost:true},{arm:'deep-only',passed:true,cost:1,unknownCost:false}]).costReductionPerCompletedTask).toBeNull(); });
});

describe('paid benchmark safeguards', () => {
  const row = (caseId: string, arm: string, cost: number, sourceHash='same'): BenchmarkRow => ({caseId, arm, cost, sourceHash, category:'trivial',passed:true,unknownCost:false,status:'completed',taskId:'id',durationMs:1});
  it('excludes unmatched or different-input arms from comparisons but retains their spending', () => {
    const metrics=pairedMetrics([row('01','smart',1),row('01','deep-only',4),row('02','smart',10),row('03','smart',1),row('03','deep-only',2,'different')]);
    expect(metrics.totalUnknownCost).toBe(false); expect(metrics.operationalCompleted).toEqual({smart:1,deep:1}); expect(metrics.pairs).toBe(1); expect(metrics.unmatchedRuns).toBe(3);
    expect(metrics.totalReportedCostUsd).toBe(18); expect(metrics.costReductionPerCompletedTask).toBe(0.75);
  });
  it('rejects duplicate arms as an invalid pair', () => {
    expect(pairedMetrics([row('01','smart',1),row('01','smart',1)]).pairs).toBe(0);
  });
  it('permits only the solution edit and exact fixture test command', () => {
    const description=(header:string,command?:string)=>header+'\n'+JSON.stringify({command});
    expect(fixturePermission('/private/tmp/fixture',description('edit: private/tmp/fixture/solution.js'))).toBe(true);
    expect(fixturePermission('/private/tmp/fixture',description('edit: solution.js'))).toBe(true);
    expect(fixturePermission('/private/tmp/fixture',description('edit: solution.test.js'))).toBe(false);
    expect(fixturePermission('/private/tmp/fixture',description('edit: ../solution.js'))).toBe(false);
    expect(fixturePermission('/private/tmp/fixture',description('bash: npm test','npm test'))).toBe(true);
    expect(fixturePermission('/private/tmp/fixture',description('bash: npm test; rm x','npm test; rm x'))).toBe(false);
    expect(fixturePermission('/private/tmp/fixture','malformed')).toBe(false);
  });
  it('interleaves categories without dropping cases',async()=>{
    const cases:BenchmarkCase[]=JSON.parse(await readFile(new URL('../benchmark/cases.json',import.meta.url),'utf8'));
    const ordered=stratifiedOrder(cases);
    expect(ordered.slice(0,4).map(c=>c.category)).toEqual(['trivial','usual','complex','sensitive']);
    expect(ordered.map(c=>c.id).sort()).toEqual(cases.map(c=>c.id).sort());
  });
});

it('flags unknown spend even when it belongs to an unmatched arm',()=>{
  expect(pairedMetrics([{caseId:'x',category:'sensitive',arm:'deep-only',passed:false,cost:1,unknownCost:true,status:'cancelled',sourceHash:'x',taskId:'x',durationMs:1}]).totalUnknownCost).toBe(true);
});


it('does not count passing tests with review findings as operational success',()=>{
  const base:BenchmarkRow={caseId:'sensitive',category:'sensitive',arm:'smart',passed:true,cost:1,unknownCost:false,status:'failed',sourceHash:'same',taskId:'s',durationMs:1,note:'REVIEW_REQUIRES_ATTENTION'};
  const metrics=pairedMetrics([base,{...base,arm:'deep-only',status:'completed',cost:4,note:undefined}]);
  expect(metrics.qualityRatio).toBe(1); // Historical test-only field remains compatible.
  expect(metrics.operational.smart.completed).toBe(0);
  expect(metrics.operational.deep.completed).toBe(1);
  expect(metrics.operational.qualityRatio).toBe(0);
  expect(metrics.operational.costReductionPerCompletedTask).toBeNull();
});
it('identifies pairs whose results were limited by the shared budget',()=>{
  const base:BenchmarkRow={caseId:'last',category:'usual',arm:'smart',passed:true,cost:1,unknownCost:false,status:'completed',sourceHash:'same',taskId:'s',durationMs:1};
  const metrics=pairedMetrics([base,{...base,arm:'deep-only',status:'blocked',passed:false,note:'BUDGET_OR_CALL_LIMIT'}]);
  expect(metrics.budgetCensoredCaseIds).toEqual(['last']);
  expect(metrics.operational.qualityRatio).toBeNull();
});


it('uses an explicit zero-budget benchmark config without any provider inference',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {defaults}=await import('../src/config.js');const {createRequire}=await import('node:module');const loader=createRequire(import.meta.url).resolve('tsx');
  const root=await mkdtemp(join(tmpdir(),'smart-benchmark-config-'));
  try{
    const config=join(root,'config.json'),output=join(root,'result.json');
    await writeFile(config,JSON.stringify({...defaults,models:{fast:'test/fast',balanced:'test/balanced',deep:'test/deep'},limits:{...defaults.limits,maxCostUsd:0}}));
    await promisify(execFile)(process.execPath,['--import',loader,new URL('../src/benchmark.ts',import.meta.url).pathname,'--run','--config',config,'--output',output],{cwd:root,env:{...process.env,OPENROUTER_API_KEY:'local-zero-budget-only'},timeout:15000});
    const report=JSON.parse(await readFile(output,'utf8'));
    expect(report.results).toEqual([]);expect(report.limits.maxCostUsd).toBe(0);expect(report.models.fast).toBe('test/fast');expect(report.stopReason).toBe('GLOBAL_BUDGET_OR_UNKNOWN_COST');expect(report.caseDefinitionsSha256).toMatch(/^[a-f0-9]{64}$/);expect(report.sourceHashes['state.ts']).toBeDefined();
  }finally{await rm(root,{recursive:true,force:true});}
});
