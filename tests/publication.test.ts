import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,writeFile,unlink,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {smokeConfig,smokeProviderConfig} from '../src/smoke-fixture.js';
const exec=promisify(execFile),audit=fileURLToPath(new URL('../scripts/audit-public.mjs',import.meta.url)),cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
it('shows English help without keys or personal configuration',async()=>{const {stdout}=await exec(process.execPath,['--import','tsx',cli,'--help']);expect(stdout).toContain('Interactive mode');expect(stdout).toContain('Reply'.toLowerCase());expect(stdout).not.toContain('Modo interactivo');});
it('rejects non-loopback smoke providers and declares a complete fake catalog',()=>{expect(()=>smokeProviderConfig('https://example.test')).toThrow('loopback');expect(Object.values(smokeConfig().models).every(x=>x.startsWith('openrouter/smart-fixture-'))).toBe(true);expect(Object.keys(smokeProviderConfig('http://127.0.0.1:1234').provider.openrouter.models)).toHaveLength(3);});
it('finds sensitive content in deleted historical blobs without printing the value',async()=>{const root=await mkdtemp(join(tmpdir(),'smart-audit-test-'));try{const git=(args:string[])=>exec('git',['-c','user.name=fixture','-c','user.email=fixture@users.noreply.github.com',...args],{cwd:root});await git(['init']);const secret='sk-or-'+'v1-'+'x'.repeat(40);await writeFile(join(root,'removed.txt'),secret);await git(['add','removed.txt']);await git(['commit','-m','Fixture']);await unlink(join(root,'removed.txt'));await git(['add','-u']);await git(['commit','-m','Remove fixture']);try{await exec(process.execPath,[audit],{cwd:root});throw new Error('Audit unexpectedly succeeded');}catch(error){const text=String(error);expect(text).toContain('provider credential');expect(text).not.toContain(secret);}}finally{await rm(root,{recursive:true,force:true});}});
it('refuses local environment files in the publication tree',async()=>{const root=await mkdtemp(join(tmpdir(),'smart-audit-env-'));try{await writeFile(join(root,'.env'),'');await expect(exec(process.execPath,[audit],{cwd:root})).rejects.toThrow('Local environment file');}finally{await rm(root,{recursive:true,force:true});}});

it('accepts the exact GitHub automation committer while rejecting personal addresses',async()=>{
  const root=await mkdtemp(join(tmpdir(),'smart-audit-identity-'));
  try{
    const git=(args:string[],email='noreply@github.com')=>exec('git',args,{cwd:root,env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@users.noreply.github.com',GIT_COMMITTER_NAME:'GitHub',GIT_COMMITTER_EMAIL:email}});
    await git(['init']);await writeFile(join(root,'safe.txt'),'public fixture');await git(['add','safe.txt']);await git(['commit','-m','Fixture automation']);
    expect(JSON.parse((await exec(process.execPath,[audit],{cwd:root})).stdout).status).toBe('passed');
    await git(['commit','--allow-empty','-m','Personal address fixture'],'contributor@example.test');
    await expect(exec(process.execPath,[audit],{cwd:root})).rejects.toThrow('Commit identity');
  }finally{await rm(root,{recursive:true,force:true});}
});
