import { OpenRouterMeter, meteredBackend } from './openrouter-meter.js';
import { loadLocalEnv } from './env.js';
import { readFile, writeFile, mkdir, mkdtemp, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadConfig, requireConfigured } from './config.js';
import { Controller } from './controller.js';
import { OpenCodeBackend } from './opencode.js';
import type { Stage, Usage } from './types.js';
import { Store, projectRoot } from './state.js';
export interface BenchmarkCase { id: string; category: string; name: string; prompt: string; checks: [unknown, unknown][] }
export const sourceFor = (c: BenchmarkCase) => `// Implement the requested behavior.\nexport function ${c.name}(input) { throw new Error('Not implemented'); }\n`;
export function testFor(c: BenchmarkCase) {
  return `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${c.name} as fn } from './solution.js';\nconst checks = ${JSON.stringify(c.checks)};\nfor (const [i, [input, expected]] of checks.entries()) test('case '+i, () => { const snapshot = structuredClone(input); assert.deepStrictEqual(fn(input), expected); assert.deepStrictEqual(input, snapshot, 'input must be preserved'); });\n`;
}
export function aggregate(rows: { arm: string; passed: boolean; cost: number; unknownCost: boolean }[]) {
  const group = (arm: string) => { const r = rows.filter(r => r.arm === arm); const completed = r.filter(r => r.passed).length; return { runs: r.length, completed, costUsd: r.reduce((n,r) => n + r.cost, 0), unknownCost: r.some(r => r.unknownCost) }; };
  const smart = group('smart'), deep = group('deep-only');
  return { smart, deep, qualityRatio: deep.completed > 0 ? smart.completed / deep.completed : null,
    costReductionPerCompletedTask: !smart.unknownCost && !deep.unknownCost && smart.completed > 0 && deep.completed > 0 && deep.costUsd > 0 ? 1 - (smart.costUsd / smart.completed) / (deep.costUsd / deep.completed) : null };
}
export interface BenchmarkRow { caseId: string; category: string; arm: string; passed: boolean; cost: number; unknownCost: boolean; status: string; sourceHash: string; taskId: string; durationMs: number; backendReportedCostUsd?: number; stages?:Stage[]; usage?:Usage[]; note?: string }
export function pairedMetrics(rows: BenchmarkRow[]) {
  const ids = [...new Set(rows.map(r => r.caseId))].filter(id => {
    const pair = rows.filter(r => r.caseId === id);
    return pair.length === 2 && pair.some(r => r.arm === 'smart') && pair.some(r => r.arm === 'deep-only') && pair[0]!.sourceHash === pair[1]!.sourceHash;
  });
  const paired = rows.filter(r => ids.includes(r.caseId));
  // Tests alone cannot satisfy review and other operational exit criteria.
  const operational = aggregate(paired.map(row => ({ ...row, passed: row.passed && row.status === 'completed' })));
  return { operational, budgetCensoredCaseIds:ids.filter(id=>paired.some(row=>row.caseId===id && row.note==='BUDGET_OR_CALL_LIMIT')), metricDefinitions:{legacyCompleted:'Independent test evaluator passed; does not imply the workflow completed.',operationalCompleted:'Independent evaluator passed and workflow status is completed.',qualityRatio:'Smart completions divided by Deep completions; not a human evaluation or a population estimate.'}, caseIds: ids, pairs: ids.length, totalUnknownCost:rows.some(r=>r.unknownCost), operationalCompleted:{smart:operational.smart.completed, deep:operational.deep.completed}, unmatchedRuns: rows.length - paired.length, totalReportedCostUsd: rows.reduce((n,r) => n+r.cost,0), ...aggregate(paired) };
}
export function stratifiedOrder(cases: BenchmarkCase[]) {
  const categories = [...new Set(cases.map(c => c.category))];
  const groups = categories.map(category => cases.filter(c => c.category === category));
  return Array.from({length: Math.max(...groups.map(g => g.length), 0)}, (_,i) => groups.flatMap(g => g[i] ? [g[i]!] : [])).flat();
}
export function fixturePermission(directory: string, description: string) {
  try {
    const i = description.indexOf('\n');
    const header = description.slice(0,i);
    const metadata = JSON.parse(description.slice(i+1));
    const target = join(directory,'solution.js');
    return (header.startsWith('edit: ') && header.slice(6).split(', ').every(p => resolve(directory,p) === target || resolve('/',p) === target)) || (header.startsWith('bash: ') && metadata.command === 'npm test');
  } catch { return false; }
}
async function main() {
  const caseDefinitions = await readFile(new URL('../benchmark/cases.json', import.meta.url), 'utf8');
  const cases: BenchmarkCase[] = JSON.parse(caseDefinitions);
  const caseDefinitionsSha256 = createHash('sha256').update(caseDefinitions).digest('hex');
  if (!process.argv.includes('--run')) { console.log(JSON.stringify({ status: 'NOT_RUN', caseDefinitionsSha256, note: '20 synthetic tasks, 40 isolated runs. They do not establish quality on real repositories.', cases: stratifiedOrder(cases).map(c => ({ id: c.id, category: c.category, prompt: c.prompt })), arms: ['smart', 'deep-only'] }, null, 2)); return; }
  const router = process.cwd();
  const project = await projectRoot(router);
  await loadLocalEnv(project);
  const configIdx=process.argv.indexOf('--config');
  const configPath=configIdx<0?undefined:process.argv[configIdx+1];
  if(configIdx>=0 && (!configPath || configPath.startsWith('--')))throw new Error('Missing value for --config');
  const config = await loadConfig(project,configPath ? resolve(configPath):undefined); requireConfigured(config);
  const budgetIdx=process.argv.indexOf('--budget');
  if(budgetIdx>=0) {const limit=Number(process.argv[budgetIdx+1]);if(!Number.isFinite(limit)||limit<=0||limit>config.limits.maxCostUsd)throw new Error('Budget must be positive and no greater than the configured limit');config.limits.maxCostUsd=limit;}
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY');
  const outIdx = process.argv.indexOf('--output'); const out = resolve(outIdx < 0 ? 'artifacts/benchmark-results.json' : process.argv[outIdx + 1] ?? 'artifacts/benchmark-results.json');
  // Never overwrite a previous paid run.
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out, '{}\n', { flag:'wx', mode:0o600 });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const scoped = process.argv.includes('--allow-fixture-tools');
  const ask = async (d: string) => !!process.stdin.isTTY && /^(sí|si|yes)$/i.test((await rl.question(`${d}\nApprove ONE operation? yes/no: `)).trim());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smart-benchmark-')));
  const previousEnv = new Map<string,string|undefined>();
  for (const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']) {
    previousEnv.set(name,process.env[name]); const path=join(root,name.toLowerCase()); await mkdir(path); process.env[name]=path;
  }
  const meter=await OpenRouterMeter.start(process.env.OPENROUTER_API_KEY);
  const sourceHashes=Object.fromEntries(await Promise.all((await readdir(new URL('.',import.meta.url))).filter(file=>file.endsWith(import.meta.url.endsWith('.js')?'.js':'.ts')).sort().map(async file=>[file,createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex')])));
  const rows: BenchmarkRow[] = [];
  let stopReason = 'running';
  const writeReport = async () => { await writeFile(out, JSON.stringify({ status: rows.length === cases.length*2 ? 'FINISHED' : 'PARTIAL', stopReason, caseDefinitionsSha256, fixtureKind: 'synthetic', fixtureRoot:root, costSource:'openrouter-generation-api', sourceHashes, executionRoot:router, sdkVersion: '1.19.3', models: config.models, limits: config.limits, timestamp: new Date().toISOString(), caseOrder:stratifiedOrder(cases).map(c=>c.id), results: rows, metrics: pairedMetrics(rows), interpretation:'Metrics use only matching pairs. All spend includes unmatched runs. Partial synthetic results cannot establish quality or savings on real repositories. Budget is checked between requests, not a hard provider spending cap.' }, null, 2), { mode: 0o600 }); };
  try {
    for (const [index, c] of stratifiedOrder(cases).entries()) for (const arm of index % 2 ? ['deep-only', 'smart'] : ['smart', 'deep-only']) {
      const totalSpent = rows.reduce((n,r) => n+r.cost, 0);
      if (rows.some(r => r.unknownCost) || totalSpent >= config.limits.maxCostUsd) { stopReason='GLOBAL_BUDGET_OR_UNKNOWN_COST'; return; }
      const directory = join(root, `${c.id}-${arm}`); await mkdir(directory);
      const source = sourceFor(c); const tests = testFor(c);
      await writeFile(join(directory, 'solution.js'), source);
      await writeFile(join(directory, 'solution.test.js'), tests);
      await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test solution.test.js' } }));
      const armConfig = structuredClone(config); armConfig.mode = arm === 'deep-only' ? 'manual' : 'auto'; armConfig.limits.maxCostUsd = config.limits.maxCostUsd - totalSpent;
      process.chdir(directory);
      const native = await OpenCodeBackend.start(directory, d=>scoped ? Promise.resolve(fixturePermission(directory,d)) : ask(d),{openrouterBaseURL:meter.baseURL});
      let backendReportedCostUsd=0;
      const backend=meteredBackend(native,meter,n=>{backendReportedCostUsd+=n;}); const start = Date.now();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        console.log(`CASE ${c.id} ${c.category} ${arm}; global $${totalSpent.toFixed(6)}/$${config.limits.maxCostUsd}`);
        const controller = new Controller(backend, armConfig, new Store(join(root, 'state')), s=>{ if (/^\[(?:FAST|BALANCED|DEEP)\]|^Result:|^Bounded repair/.test(s)) console.log(s); });
        if (arm === 'deep-only') controller.preferredModel = () => 'deep';
        watchdog=setTimeout(()=>{ void controller.cancel().catch(()=>false); },180000);
        const task = await controller.run(`${c.prompt}\nEdita solo solution.js con edit, conserva solution.test.js y package.json. Usa read para explorar. Ejecuta exactamente npm test para validar; no añadas echo ni operadores de shell. El wrapper recoge el exit code estructurado. No ejecutes otros comandos.`, directory);
        clearTimeout(watchdog);
        let passed = false;
        if (scoped || await ask(`Evaluate generated code with node --test in ${directory}`)) {
          await writeFile(join(directory, 'solution.test.js'), tests);
          try { await promisify(execFile)(process.execPath, ['--test', 'solution.test.js'], { cwd: directory, timeout: 30000, maxBuffer: 1024 * 1024 }); passed = true; } catch { passed = false; }
        }
        rows.push({ caseId: c.id, category: c.category, arm, passed, cost: task.spent, unknownCost: task.unknownCost, status: task.status, note:task.note, backendReportedCostUsd, stages:task.stages, usage:task.usage, sourceHash: createHash('sha256').update(source + tests).digest('hex'), taskId: task.id, durationMs: Date.now() - start });
        console.log(`EVALUATED ${c.id} ${arm}: ${passed ? 'PASS' : 'FAIL'}; $${task.spent.toFixed(8)}`);
        await writeReport();
        if (task.note === 'BUDGET_OR_CALL_LIMIT') { stopReason='BUDGET_OR_CALL_LIMIT'; return; }
      } finally { if(watchdog)clearTimeout(watchdog); await backend.close(); process.chdir(router); }
    }
    stopReason='completed';
  } catch(error) { stopReason='HARNESS_ERROR'; throw error; }
  finally {
    meter.close(); process.chdir(router);
    for(const [name,value] of previousEnv) { if(value===undefined)delete process.env[name]; else process.env[name]=value; }
    await writeReport(); rl.close(); console.log(`Results: ${out}\nFixtures retained for inspection: ${root}`);
  }
}
if (process.argv[1] && /benchmark\.(?:ts|js)$/.test(process.argv[1])) main().catch(e => { console.error(e.message); process.exitCode = 1; });
