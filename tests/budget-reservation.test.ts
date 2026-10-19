import {describe,it,expect} from 'vitest';
import {reserveTextCompletion} from '../src/budget-reservation.js';
const prices={input:0.0000176,output:0.000044};
const text=(max_tokens=3072)=>({model:'fixture',messages:[{role:'user',content:'hello'}],max_tokens});
describe('text completion reservation',()=>{
 it('reduces output for the actual pilot boundary without changing input rates or total cap',()=>{
  const body=text();body.messages[0]!.content='x'.repeat(110154-2048-Buffer.byteLength(JSON.stringify(body))+5);
  const original=structuredClone(body);const r=reserveTextCompletion(body,prices,2.063695228);
  expect(r.inputTokenUpperBound).toBe(110154);expect(r.maxOutputTokens).toBe(2840);
  expect(r.admitted).toBe(true);expect(r.outputReduced).toBe(true);expect(r.reserveUsd).toBeLessThanOrEqual(2.063695228);
  expect(body).toEqual(original);
 });
 it('denies when even minimum useful output cannot be funded',()=>{
  const r=reserveTextCompletion(text(),prices,0.001);expect(r.admitted).toBe(false);
 });
 it('never increases either client output limit',()=>{
  const r=reserveTextCompletion({...text(128),max_completion_tokens:64},prices,10);
  expect(r.maxOutputTokens).toBe(64);expect(r.body.max_completion_tokens).toBe(64);
 });
 it('does not reject a deliberately small request when it can be funded',()=>{
  expect(reserveTextCompletion(text(16),prices,1).admitted).toBe(true);
 });
 it('keeps free models bounded by the requested token cap',()=>{
  const r=reserveTextCompletion(text(),{input:0,output:0},0);expect(r.admitted).toBe(true);expect(r.maxOutputTokens).toBe(3072);
 });
 it('refuses a reduction that cannot accommodate explicit reasoning tokens',()=>{
  const r=reserveTextCompletion({...text(),reasoning:{max_tokens:3000}},prices,0.1);expect(r.admitted).toBe(false);
 });
 it.each([-1,NaN,Infinity])('rejects invalid financial inputs %s',n=>{
  expect(()=>reserveTextCompletion(text(),prices,n)).toThrow();
  expect(()=>reserveTextCompletion(text(),{input:n,output:1},1)).toThrow();
 });
 it.each([0,-1,1.5,'100'])('rejects invalid token caps %s',n=>{
  expect(()=>reserveTextCompletion({...text(),max_tokens:n},prices,1)).toThrow();
 });
 it('rejects image pricing through the text-only estimator',()=>{
  expect(()=>reserveTextCompletion({messages:[{content:[{type:'image_url',image_url:{url:'https://example.test/x'}}]}]},prices,10)).toThrow();
 });
 it('keeps reservations within every admitted budget across a deterministic grid',()=>{
  for(const size of [0,10,1000,10000])for(const budget of [0,0.01,0.1,0.5,1,2]){
   const body=text();body.messages[0]!.content='x'.repeat(size);const r=reserveTextCompletion(body,prices,budget);
   if(r.admitted){expect(r.reserveUsd).toBeLessThanOrEqual(budget);expect(r.maxOutputTokens).toBeGreaterThanOrEqual(512);}
  }
 });
});
