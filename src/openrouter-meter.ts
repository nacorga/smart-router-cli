import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Backend, Usage } from './types.js';

export interface MeterLimits { maxRequests?:number; maxOutputTokens?:number; disableTools?:boolean; localDenialToken?:string }
type RequestRecord = { ids: Set<string>; finished: boolean; localDenialId?:string };
/** Ephemeral loopback relay: retains generation IDs, never prompts, responses or credentials. */
export class OpenRouterMeter {
  private records: RequestRecord[] = [];
  private constructor(private server: Server, readonly baseURL: string, private apiKey: string, private upstream: string, private retryDelays: number[], private limits:MeterLimits) {}
  static async start(apiKey: string, upstream = 'https://openrouter.ai/api/v1', retryDelays = [500,1000,2000,4000,8000], limits:MeterLimits={}) {
    if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');
    if(limits.maxRequests!==undefined&&(!Number.isInteger(limits.maxRequests)||limits.maxRequests<0))throw new Error('Invalid request limit');
    if(limits.maxOutputTokens!==undefined&&(!Number.isInteger(limits.maxOutputTokens)||limits.maxOutputTokens<1))throw new Error('Invalid output token limit');
    if(limits.localDenialToken!==undefined){
      const address=new URL(upstream);
      if(!limits.localDenialToken || address.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(address.hostname))throw new Error('Local denial proof requires a loopback relay');
    }
    let meter: OpenRouterMeter;
    const server = createServer((req,res) => { void (async()=>{
      if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401).end(); return; }
      if(limits.maxRequests!==undefined&&meter.records.length>=limits.maxRequests){req.resume();res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Local inference request limit reached',code:403}}));return;}
      const record: RequestRecord = { ids:new Set(), finished:false }; meter.records.push(record);
      const abort = new AbortController();
      res.on('close',()=>{ if(!res.writableFinished) abort.abort(); });
      try {
        const chunks: Buffer[] = []; let size=0;
        for await (const chunk of req) { const b=Buffer.from(chunk); size+=b.length; if(size>16*1024*1024)throw new Error('Request too large'); chunks.push(b); }
        let body=Buffer.concat(chunks).toString('utf8');
        if(limits.maxOutputTokens!==undefined||limits.disableTools){
          const data=JSON.parse(body);
          if(limits.maxOutputTokens!==undefined){data.max_tokens=Math.min(Number(data.max_tokens)||limits.maxOutputTokens,limits.maxOutputTokens);if(data.max_completion_tokens!==undefined)data.max_completion_tokens=Math.min(Number(data.max_completion_tokens)||limits.maxOutputTokens,limits.maxOutputTokens);}
          if(limits.disableTools){delete data.tools;delete data.tool_choice;delete data.parallel_tool_calls;}
          body=JSON.stringify(data);
        }
        const response = await fetch(`${upstream}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body,signal:abort.signal});
        if(response.status===403 && limits.localDenialToken && response.headers.get('x-smart-router-local-denial')===limits.localDenialToken){record.localDenialId=`local-denied-${randomUUID()}`;record.finished=true;}
        res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});
        if(!response.body) { res.end(); return; }
        // Preserve provider error details for the native SDK; do not replace them with an empty body.
        if(!response.ok) { for await(const chunk of response.body) res.write(chunk);res.end();return; }
        const decoder=new TextDecoder(); let pending='';
        const capture=(text:string)=>{ try {const data=JSON.parse(text); if(typeof data.id==='string' && /^gen-[A-Za-z0-9-]+$/.test(data.id))record.ids.add(data.id);}catch{/* SSE heartbeat or terminal marker. */} };
        const streaming=response.headers.get('content-type')?.includes('text/event-stream');
        for await(const chunk of response.body) {
          pending+=decoder.decode(chunk,{stream:true});
          if(streaming) { let end:number; while((end=pending.indexOf('\n'))>=0) {const line=pending.slice(0,end).trimEnd();pending=pending.slice(end+1);if(line.startsWith('data:'))capture(line.slice(5).trim());} }
          if(pending.length>4*1024*1024)throw new Error('Response frame too large');
          if(!res.write(chunk)) await new Promise<void>((resolve,reject)=>{res.once('drain',resolve);res.once('close',()=>reject(new Error('Disconnected')));});
        }
        pending+=decoder.decode();
        if(streaming) {if(pending.startsWith('data:'))capture(pending.slice(5).trim());} else capture(pending);
        record.finished=true; res.end();
      } catch { if(!res.headersSent)res.writeHead(502);res.end(); }
    })().catch(()=>{res.destroy();}); });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address(); if(!address || typeof address==='string')throw new Error('Relay address unavailable');
    meter=new OpenRouterMeter(server,`http://127.0.0.1:${address.port}`,apiKey,upstream,retryDelays,limits);
    return meter;
  }
  mark() { return this.records.length; }
  async usageSince(mark: number, modelId: string): Promise<Usage[]> {
    const records=this.records.slice(mark);
    const usages=await Promise.all(records.map(async record=>{
      if(record.localDenialId)return [{messageId:record.localDenialId,inputTokens:0,outputTokens:0,costUsd:0,source:'local' as const}];
      const unresolved:Usage[] = !record.finished || !record.ids.size ? [{messageId:`unresolved-${randomUUID()}`,inputTokens:0,outputTokens:0,source:'unknown'}] : [];
      const resolved=await Promise.all([...record.ids].map(async(id):Promise<Usage>=>{
        for(let attempt=0;attempt<=this.retryDelays.length;attempt++) {
          try {
            const response=await fetch(`${this.upstream}/generation?id=${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${this.apiKey}`},signal:AbortSignal.timeout(5000)});
            if(response.ok) {
              const {data}=await response.json() as {data:{id:string;model:string;total_cost:number;native_tokens_prompt:number;native_tokens_completion:number;finish_reason?:string}};
              if(data.id!==id || !(data.model===modelId || data.model.startsWith(`${modelId}-`))) break;
              if(typeof data.total_cost==='number' && Number.isFinite(data.total_cost) && data.total_cost>=0 && data.finish_reason) {
                return {messageId:id,inputTokens:data.native_tokens_prompt,outputTokens:data.native_tokens_completion,costUsd:data.total_cost,source:'provider'};
              }
            } else if(response.status!==404 && response.status!==429 && response.status<500) break;
          } catch {/* Missing provider evidence stays unknown. */}
          if(attempt<this.retryDelays.length)await new Promise(resolve=>setTimeout(resolve,this.retryDelays[attempt]));
        }
        return {messageId:id,inputTokens:0,outputTokens:0,source:'unknown'};
      }));
      return [...unresolved,...resolved];
    }));
    return usages.flat();
  }

  close() { this.server.closeAllConnections();this.server.close();this.apiKey=''; }
}
export function meteredBackend(backend:Backend,meter:OpenRouterMeter,onBackendCost:(n:number)=>void):Backend {
  return {catalog:()=>backend.catalog(),create:()=>backend.create(),prepare:id=>backend.prepare!(id),abort:id=>backend.abort(id),close:()=>backend.close(),prompt:async(id,model,prompt,stage,onText)=>{
    const mark=meter.mark();
    const result=await backend.prompt(id,model,prompt,stage,onText);
    onBackendCost(result.usage.reduce((n,u)=>n+(u.costUsd??0),0));
    const usage=await meter.usageSince(mark,model.replace(/^openrouter\//,''));
    const locallyDenied=usage.some(u=>u.source==='local');
    return {...result,usage,...(locallyDenied?{failure:result.failure==='permission'?'permission' as const:'limit' as const,retryable:false}:{})};
  }};
}
