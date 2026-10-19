import {spawn} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {stopChild} from '../src/server.js';
async function child(ignore:boolean){
  const processChild=spawn(process.execPath,['-e',`${ignore?"process.on('SIGTERM',()=>{});":''}console.log('READY');setInterval(()=>{},1000);`],{stdio:'pipe'});
  await new Promise<void>((resolve,reject)=>{processChild.stdout.once('data',()=>resolve());processChild.once('error',reject);});return processChild;
}
describe('dedicated server shutdown',()=>{
  it('waits for a graceful child exit and permits repeated cleanup',async()=>{
    const processChild=await child(false);try{await stopChild(processChild,1000);expect(processChild.signalCode).toBe('SIGTERM');await stopChild(processChild,1000);}finally{processChild.kill('SIGKILL');}
  });
  it('terminates its own child if SIGTERM is ignored',async()=>{
    const processChild=await child(true);try{await stopChild(processChild,50);expect(processChild.signalCode).toBe('SIGKILL');}finally{processChild.kill('SIGKILL');}
  });
});
