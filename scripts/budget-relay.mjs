import {createServer} from 'node:http';
import {reserveTextCompletion} from '../dist/budget-reservation.js';
export async function startBudgetRelay({apiKey,models,maxCostUsd=5,maxOutputTokens=2048,maxRequests=80,upstream='https://openrouter.ai/api/v1',initialCostUsd=0,localDenialToken,onCheckpoint=async()=>{}}){
 const state={spentUsd:initialCostUsd,unknownCost:false,records:[],denials:[]};const receipts=new Map();let active=false;
 const headers={Authorization:'Bearer '+apiKey,'Content-Type':'application/json'};
 const server=createServer((req,res)=>{void(async()=>{
  if(req.headers.authorization!==headers.Authorization){res.writeHead(401).end();return;}
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/generation'){
   const data=receipts.get(url.searchParams.get('id'));if(data){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data}));return;}
   res.writeHead(404).end();return;
  }
  if(req.method!=='POST'||url.pathname!=='/chat/completions'){res.writeHead(404).end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());const prices=models[body.model];
  if(!prices){res.writeHead(400).end(JSON.stringify({error:{message:'Model price not frozen'}}));return;}
  const reservation=reserveTextCompletion(body,prices,maxCostUsd-state.spentUsd,maxOutputTokens);
  const {inputTokenUpperBound,reserveUsd}=reservation;const serialized=JSON.stringify(reservation.body);
  if(active||state.unknownCost||state.records.length>=maxRequests||!reservation.admitted){state.denials.push({model:body.model,spentUsd:state.spentUsd,reserveUsd,unknownCost:state.unknownCost,reason:active?'CONCURRENT_REQUEST':state.unknownCost?'UNKNOWN_COST':state.records.length>=maxRequests?'REQUEST_LIMIT':'BUDGET_RESERVE'});await onCheckpoint(state);res.writeHead(403,{'Content-Type':'application/json',...(localDenialToken?{'X-Smart-Router-Local-Denial':localDenialToken}:{})}).end(JSON.stringify({error:{message:'Local pilot budget guard stopped request before provider',code:403}}));return;}
  active=true;const record={model:body.model,inputTokenUpperBound,maxOutputTokens:reservation.maxOutputTokens,requestedOutputTokens:reservation.requestedOutputTokens,outputReduced:reservation.outputReduced,reserveUsd,generationIds:[],costUsd:0,status:'forwarding',startedAt:new Date().toISOString()};state.records.push(record);await onCheckpoint(state);
  try{
   const response=await fetch(upstream+'/chat/completions',{method:'POST',headers,body:serialized,signal:AbortSignal.timeout(180000)});record.httpStatus=response.status;res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});
   let pending='';const decoder=new TextDecoder(),streaming=response.headers.get('content-type')?.includes('text/event-stream');
   const capture=s=>{try{const j=JSON.parse(s);if(typeof j.id==='string'&&/^gen-[A-Za-z0-9-]+$/.test(j.id)&&!record.generationIds.includes(j.id))record.generationIds.push(j.id);}catch{}};
   if(response.body)for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});if(streaming){let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.startsWith('data:'))capture(line.slice(5).trim());}}res.write(chunk);}
   pending+=decoder.decode();if(!streaming)capture(pending);else if(pending.startsWith('data:'))capture(pending.slice(5).trim());
   for(const id of record.generationIds){let found;for(const delay of [0,500,1000,2000,4000,8000]){if(delay)await new Promise(r=>setTimeout(r,delay));try{const r=await fetch(upstream+'/generation?id='+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(5000)});if(r.ok){const {data}=await r.json();if(data.id===id&&data.finish_reason&&typeof data.total_cost==='number'&&Number.isFinite(data.total_cost)&&data.total_cost>=0){found=data;break;}}}catch{}}
    if(found){receipts.set(id,found);record.costUsd+=found.total_cost;}else state.unknownCost=true;
   }
   if(!record.generationIds.length)state.unknownCost=true;
   state.spentUsd+=record.costUsd;record.status=state.unknownCost?'unresolved':'confirmed';
   if(record.costUsd>reserveUsd+1e-8){state.unknownCost=true;record.reserveExceeded=true;}
   await onCheckpoint(state);res.end();
  }catch{state.unknownCost=true;record.status='transport_unknown';await onCheckpoint(state);if(!res.headersSent)res.writeHead(502);res.end();}
  finally{active=false;}
 })().catch(()=>{state.unknownCost=true;active=false;res.destroy();});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {baseURL:'http://127.0.0.1:'+server.address().port,state,receipts,close:()=>{server.closeAllConnections();server.close();}};
}
