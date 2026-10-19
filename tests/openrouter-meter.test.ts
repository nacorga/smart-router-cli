import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, Result } from '../src/types.js';
import { createServer, type Server } from 'node:http';
import { OpenRouterMeter, meteredBackend, type MeterLimits } from '../src/openrouter-meter.js';
const servers:Server[]=[];const meters:OpenRouterMeter[]=[];
afterEach(()=>{for(const meter of meters.splice(0))meter.close();for(const server of servers.splice(0)){server.closeAllConnections();server.close();}});
async function fixture(options:{cost?:number;model?:string;id?:string;missing?:boolean; delayed?:boolean; rejection?:boolean;localDenial?:string;limits?:MeterLimits;onRequest?:(data:Record<string,unknown>)=>void}={}) {
  let polls=0;
  const server=createServer(async(req,res)=>{
    if(req.url?.startsWith('/generation')) {
      if(options.missing || (options.delayed && polls++<2)){res.writeHead(404).end();return;}
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({data:{id:'gen-test-1',model:options.model??'model-20261018',total_cost:options.cost??0.07,finish_reason:'stop',native_tokens_prompt:100,native_tokens_completion:5}}));return;
    }
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));options.onRequest?.(JSON.parse(Buffer.concat(chunks).toString()));
    if(options.localDenial){res.writeHead(403,{'content-type':'application/json','x-smart-router-local-denial':options.localDenial}).end(JSON.stringify({error:{message:'Local reserve exhausted',code:403}}));return;}
    if(options.rejection){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Invalid schema',code:400}}));return;}
    res.setHeader('content-type','text/event-stream');
    const data=`data: ${JSON.stringify({id:options.id??'gen-test-1',choices:[{delta:{content:'sensitive content never retained'}}]})}\n\ndata: [DONE]\n\n`;
    res.write(data.slice(0,17));res.end(data.slice(17));
  });servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No address');
  const meter=await OpenRouterMeter.start('test-key',`http://127.0.0.1:${address.port}`,[1,2],options.limits);meters.push(meter);return meter;
}
async function complete(meter:OpenRouterMeter,key='test-key') {
  const response=await fetch(`${meter.baseURL}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:'{"stream":true}'});
  await response.text();return response.status;
}
describe('provider cost meter',()=>{
  it('captures split SSE IDs and replaces backend estimates with provider evidence',async()=>{
    const meter=await fixture();const mark=meter.mark();await complete(meter);
    expect(await meter.usageSince(mark,'model')).toEqual([{messageId:'gen-test-1',inputTokens:100,outputTokens:5,costUsd:0.07,source:'provider'}]);
    const next=meter.mark();expect(await meter.usageSince(next,'model')).toEqual([]);
  });
  it('waits for eventually consistent generation records without repeating inference',async()=>{
    const meter=await fixture({delayed:true});await complete(meter);expect((await meter.usageSince(0,'model'))[0]?.costUsd).toBe(0.07);expect(meter.mark()).toBe(1);
  });
  it('accepts zero only when explicitly confirmed by the provider',async()=>{
    const meter=await fixture({cost:0});await complete(meter);expect((await meter.usageSince(0,'model'))[0]?.costUsd).toBe(0);
  });
  it.each([{missing:true},{model:'different'},{id:'unrecognized-id'},{cost:-1}])('keeps unavailable or mismatched generation costs unknown: %j',async options=>{
    const meter=await fixture(options);await complete(meter);const usage=await meter.usageSince(0,'model');
    expect(usage.length).toBeGreaterThan(0);expect(usage.every(u=>u.source==='unknown'&&u.costUsd===undefined)).toBe(true);
  });
  it('forwards provider rejection details without treating the request as free',async()=>{
    const meter=await fixture({rejection:true});
    const response=await fetch(`${meter.baseURL}/chat/completions`,{method:'POST',headers:{Authorization:'Bearer test-key'},body:'{}'});
    expect(response.status).toBe(400);expect(await response.json()).toEqual({error:{message:'Invalid schema',code:400}});
    expect((await meter.usageSince(0,'model'))[0]?.source).toBe('unknown');
  });
  it('rejects other routes and incorrect credentials without upstream inference',async()=>{
    const meter=await fixture();expect(await complete(meter,'wrong')).toBe(401);
    expect((await fetch(`${meter.baseURL}/other`)).status).toBe(404);expect(meter.mark()).toBe(0);
  });
});

it('bounds diagnostic inference before forwarding and disables tool definitions',async()=>{
  let forwarded=0;let body:Record<string,unknown>={};
  const meter=await fixture({limits:{maxRequests:1,maxOutputTokens:128,disableTools:true},onRequest:data=>{forwarded++;body=data;}});
  const response=await fetch(`${meter.baseURL}/chat/completions`,{method:'POST',headers:{Authorization:'Bearer test-key'},body:JSON.stringify({max_tokens:1000,tools:[{type:'function'}],tool_choice:'auto',stream:true})});await response.text();
  expect(body.max_tokens).toBe(128);expect(body).not.toHaveProperty('tools');expect(body).not.toHaveProperty('tool_choice');
  expect(await complete(meter)).toBe(403);expect(forwarded).toBe(1);expect(meter.mark()).toBe(1);
});


describe('trusted local denials',()=>{
  it('records a proven local pre-provider denial as zero local cost without generation polling',async()=>{
    const meter=await fixture({localDenial:'nonce',limits:{localDenialToken:'nonce'}});expect(await complete(meter)).toBe(403);
    const usage=await meter.usageSince(0,'model');expect(usage).toHaveLength(1);expect(usage[0]).toMatchObject({source:'local',costUsd:0});
    expect((await meter.usageSince(0,'model'))[0]?.messageId).toBe(usage[0]?.messageId);
  });
  it.each([undefined,'different'])('keeps unproven rejections unknown for token %s',async token=>{
    const meter=await fixture({localDenial:'nonce',limits:token?{localDenialToken:token}:{}});await complete(meter);
    expect((await meter.usageSince(0,'model'))[0]?.source).toBe('unknown');
  });
  it('never trusts local denial markers from a remote origin',async()=>{
    await expect(OpenRouterMeter.start('key','https://example.test',[],{localDenialToken:'nonce'})).rejects.toThrow('loopback');
  });
});

it.each(['infrastructure','permission'] as const)('keeps a trusted local guard distinct from provider errors while preserving %s precedence',async failure=>{
  const meter=await fixture({localDenial:'nonce',limits:{localDenialToken:'nonce'}});
  const backend:Backend={catalog:async()=>[],create:async()=>'',abort:async()=>true,close:()=>{},prompt:async()=>{
    await complete(meter);return {text:'',usage:[],validation:'passed',evidence:['test:passed'],failure,retryable:true} satisfies Result;
  }};
  const result=await meteredBackend(backend,meter,()=>{}).prompt('s','model','goal','validate',()=>{});
  expect(result.failure).toBe(failure==='permission'?'permission':'limit');expect(result.retryable).toBe(false);
  expect(result.validation).toBe('passed');expect(result.evidence).toEqual(['test:passed']);expect(result.usage[0]).toMatchObject({source:'local',costUsd:0});
});
it('does not reclassify a remote rejection without local proof',async()=>{
  const meter=await fixture({rejection:true});
  const backend:Backend={catalog:async()=>[],create:async()=>'',abort:async()=>true,close:()=>{},prompt:async()=>{await complete(meter);return {text:'',usage:[],validation:'none',evidence:[],failure:'infrastructure',retryable:true};}};
  const result=await meteredBackend(backend,meter,()=>{}).prompt('s','model','goal','validate',()=>{});
  expect(result.failure).toBe('infrastructure');expect(result.usage[0]?.source).toBe('unknown');
});
