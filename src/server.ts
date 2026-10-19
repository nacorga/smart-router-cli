import {spawn, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import type {Config} from '@opencode-ai/sdk/v2';
/** Stop only the child we created, waiting for exit; SIGTERM may be ignored by a busy native server. */
export async function stopChild(child:ChildProcess,graceMs=2000):Promise<void>{
  if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(resolve,graceMs);})]);
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  }finally{if(timer)clearTimeout(timer);child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();}
}
/** Own the pinned binary's lifecycle while using the SDK for all server APIs. */
export async function startDedicatedServer(directory:string,config:Config){
  const require=createRequire(import.meta.url);
  const executable=join(dirname(require.resolve('opencode-ai/package.json')),'bin','opencode.exe');
  const child=spawn(executable,['serve','--hostname=127.0.0.1','--port=0'],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(config)}});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=stopChild(child);
  // Drain server logs without duplicating their potentially private contents in wrapper telemetry.
  child.stderr?.on('data',()=>{});
  try{
    const url=await new Promise<string>((resolve,reject)=>{
      let pending='';let settled=false;
      const timer=setTimeout(()=>{settled=true;reject(new Error('Timed out starting OpenCode server'));},30000);
      const fail=(message:string)=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error(message));};
      child.once('error',()=>fail('Could not start the pinned OpenCode executable'));
      child.once('exit',()=>fail('OpenCode server exited before becoming ready'));
      child.stdout?.on('data',chunk=>{
        if(settled)return;pending+=String(chunk);if(pending.length>65536){fail('Invalid OpenCode startup response');return;}
        let end:number;
        while((end=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,end).trim();pending=pending.slice(end+1);
          const match=/^opencode server listening on (https?:\/\/\S+)$/.exec(line);
          if(!match)continue;
          try{const parsed=new URL(match[1]!);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||!parsed.port)throw new Error();settled=true;clearTimeout(timer);resolve(parsed.origin);}
          catch{fail('Invalid OpenCode server address');}return;
        }
      });
    });
    return {url,close};
  }catch(error){await close();throw error;}
}
