import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {defaults} from './config.js';
/** Deterministic development fixture: never use personal model configuration. */
export function smokeConfig() {
  const config=structuredClone(defaults);
  config.models={fast:'openrouter/smart-fixture-fast',balanced:'openrouter/smart-fixture-balanced',deep:'openrouter/smart-fixture-deep'};
  config.limits.maxCostUsd=0.1;
  return config;
}
export function smokeProviderConfig(baseURL:string) {
  const address=new URL(baseURL);
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||!address.port)throw new Error('Smoke provider must be a loopback HTTP server');
  return {enabled_providers:['openrouter'],share:'disabled',autoupdate:false,provider:{openrouter:{options:{baseURL},models:Object.fromEntries(['fast','balanced','deep'].map(tier=>['smart-fixture-'+tier,{id:'smart-fixture-'+tier,name:'Local fixture '+tier,tool_call:true,reasoning:false,attachment:false,limit:{context:200000,output:8192},cost:{input:1,output:1},modalities:{input:['text'],output:['text']}}]))}}};
}
export async function writeSmokeProvider(directory:string,baseURL:string) {
  await writeFile(join(directory,'opencode.json'),JSON.stringify(smokeProviderConfig(baseURL)));
}
