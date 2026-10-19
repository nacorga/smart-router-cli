import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults } from '../src/config.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts',import.meta.url));
let fixture:string;
beforeAll(async()=>{fixture=await mkdtemp(join(tmpdir(),'smart-cli-test-'));});
afterAll(async()=>{await rm(fixture,{recursive:true,force:true});});
async function preview(mode:'auto'|'manual',args:string[]) {
  const path=join(fixture,`${mode}.json`);
  await writeFile(path,JSON.stringify({...defaults,mode,models:{fast:'test/fast',balanced:'test/balanced',deep:'test/deep'}}));
  const {stdout}=await exec(process.execPath,['--import','tsx',cli,'--config',path,'--plan',...args],{timeout:15000});
  return JSON.parse(stdout);
}
describe('CLI routing preview',()=>{
  it('honors deep-only on every stage before any provider access',async()=>{
    const route=await preview('auto',['--deep-only','Implementa pagos']);
    expect(route.availabilityChecked).toBe(false);
    expect(route.stages).toHaveLength(5);
    expect(route.stages.every((s:{tier:string;modelId:string})=>s.tier==='deep'&&s.modelId==='test/deep')).toBe(true);
  });
  it('honors configured manual mode even for a read task',async()=>{
    expect((await preview('manual',['Encuentra el parser'])).stages).toEqual([{kind:'explore',tier:'balanced',modelId:'test/balanced'}]);
  });
  it('retains a migration with auxiliary reads as a mixed-stage task',async()=>{
    const route=await preview('auto',['Migra múltiples módulos. Usa read para explorar.']);
    expect(route.stages.map((s:{tier:string})=>s.tier)).toEqual(['fast','deep','balanced','balanced']);
  });
});
