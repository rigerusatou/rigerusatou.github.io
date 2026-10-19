import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeMultiPageBatch,encodeBatchPath,validateBatchTarget} from '../multipage-batch.mjs';

const base='https://www.selenium.dev/selenium/web/index.html';
const mkStep=(path,kind='TEXT',chunk=0)=>({
 action:'READ_TEXT',locator:{kind:'role',role:'link',
 name:'SELFISH_BATCH_'+kind+'_CHUNK_'+String(chunk).padStart(3,'0')+'_'+encodeBatchPath(path)},
 max_chars:2048
});
const job=(steps,override={})=>({request_id:'batch:abcde123456',target_url:base,steps,deviceId:'dev',...override});
const fake=redirect=>async(_id,op,data)=>({
 status:'PASS',
 result:{result:{
  final_url:redirect||data.target_url,
  step_results:data.steps.map((s,i)=>i===0?{pass:true,action:'NAVIGATE',url:data.target_url}:
   i===1?{pass:true,action:'READ_TITLE',value:'Example title'}:
   {pass:true,action:'READ_TEXT',
    source:s.locator.name.includes('PAGE_TEXT')?'VISIBLE_PAGE_TEXT':'VISIBLE_PAGE_LINKS',
    chunk_index:Number(s.locator.name.match(/_(\d{3})$/)[1]),value:'verified text'})
 }}
});

test('normal S9 request IDs are unaffected',async()=>{
 assert.equal(await routeMultiPageBatch({...job([mkStep('/test')]),request_id:'ordinary:123:abcdefghi',sendDeviceJob:fake()}),null);
});
test('two explicit pages generate two bounded read-only worker jobs',async()=>{
 const seen=[];
 const steps=[mkStep('/selenium/web/web-form.html'),mkStep('/selenium/web/web-form.html','LINKS'),mkStep('/selenium/web/index.html')];
 const r=await routeMultiPageBatch({...job(steps),sendDeviceJob:async(...args)=>{seen.push(args);return fake()(...args);}});
 assert.equal(r.status,'PASS');
 assert.equal(r.result.route,'PUBLIC_MULTIPAGE_READ_ONLY');
 assert.equal(r.result.pages_processed,2);
 assert.equal(r.result.step_results.length,3);
 assert.equal(seen.length,2);
 assert.ok(r.result.step_results.every(x=>x.pass===true&&x.value==='verified text'));
 for(const [_device,operation,input] of seen){
  assert.equal(operation,'PUBLIC_BROWSER_TASK');
  assert.equal(input.side_effect_approval,false);
  assert.deepEqual(input.steps.slice(0,2).map(x=>x.action),['NAVIGATE','READ_TITLE']);
  assert.ok(input.target_url.startsWith('https://www.selenium.dev/'));
 }
});
test('same-origin public pages with numeric navigation ids are accepted',()=>{
 assert.equal(validateBatchTarget(base,encodeBatchPath('/course/view.php?id=42')),'https://www.selenium.dev/course/view.php?id=42');
});
test('protocol switches, sensitive queries and mutating paths blocked',()=>{
 for(const path of [
  '//evil.org/','/logout','/delete?id=42','/submit','/a/../b','/a/%2e%2e/b',
  '/course?id=1&token=SECRET','/course?id=abc','/course#secret','/course?x=1'
 ]) assert.equal(validateBatchTarget(base,encodeBatchPath(path)),null,path);
});
test('writes, nonrole locators and oversize reads are rejected before dispatch',async()=>{
 const bad=[
  {action:'CLICK',locator:{kind:'role',role:'link',name:'Submit'}},
  {...mkStep('/home'),max_chars:4096},
  {...mkStep('/home'),locator:{kind:'role',role:'button',name:'Submit'}}
 ];
 for(const step of bad){
  const r=await routeMultiPageBatch({...job([step]),sendDeviceJob:async()=>{throw Error('not called');}});
  assert.equal(r.status,'BLOCKED');
 }
});
test('caps distinct pages to three',async()=>{
 const request=job(['/a','/b','/c','/d'].map(p=>mkStep(p)));
 const r=await routeMultiPageBatch({...request,sendDeviceJob:async()=>{throw Error('not called');}});
 assert.equal(r.reason,'MULTIPAGE_PAGE_LIMIT');
});
test('outages and malformed worker responses cannot report PASS',async()=>{
 const a=await routeMultiPageBatch({...job([mkStep('/a')]),sendDeviceJob:async()=>({status:'DEVICE_OFFLINE'})});
 assert.equal(a.status,'DEVICE_OFFLINE');
 const b=await routeMultiPageBatch({...job([mkStep('/a')]),sendDeviceJob:async()=>({status:'PASS',result:{result:{final_url:base,step_results:[]}}})});
 assert.equal(b.status,'BLOCKED');
});
test('cross-origin worker redirect is rejected even with PASS status',async()=>{
 const r=await routeMultiPageBatch({...job([mkStep('/a')]),sendDeviceJob:fake('https://untrusted.example.net/elsewhere')});
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.reason,'MULTIPAGE_REDIRECT_OR_ORIGIN_MISMATCH');
});
test('duplicate read specs do not trigger extra navigation',async()=>{
 const calls=[];
 const steps=[mkStep('/a'),mkStep('/a')];
 const r=await routeMultiPageBatch({...job(steps),sendDeviceJob:async(...args)=>{calls.push(args);return fake()(...args);}});
 assert.equal(r.status,'PASS');
 assert.equal(calls.length,1);
 assert.equal(calls[0][2].steps.length,3);
 assert.equal(r.result.step_results.length,2);
});

test('rejects more than six unique reads per page before any worker dispatch',async()=>{
 const steps=Array.from({length:7},(_,i)=>mkStep('/selenium/web/index.html','TEXT',i));
 const r=await routeMultiPageBatch({...job(steps),sendDeviceJob:async()=>{throw Error('SHOULD_NOT_DISPATCH');}});
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.reason,'MULTIPAGE_PER_PAGE_STEP_LIMIT');
});
test('allows six reads plus navigation and title, within worker eight-step limit',async()=>{
 let seen;
 const steps=Array.from({length:6},(_,i)=>mkStep('/selenium/web/index.html','TEXT',i));
 const r=await routeMultiPageBatch({...job(steps),sendDeviceJob:async(...args)=>{seen=args;return fake()(...args);}});
 assert.equal(r.status,'PASS');
 assert.equal(seen[2].steps.length,8);
});
test('rejects out-of-range chunk index before dispatch',async()=>{
 const r=await routeMultiPageBatch({...job([mkStep('/selenium/web/index.html','TEXT',999)]),sendDeviceJob:async()=>{throw Error('SHOULD_NOT_DISPATCH');}});
 assert.equal(r.reason,'INVALID_MULTIPAGE_TARGET_OR_STEP');
});
test('rejects same-origin redirects to another page to preserve source attribution',async()=>{
 const r=await routeMultiPageBatch({...job([mkStep('/a')]),sendDeviceJob:fake('https://www.selenium.dev/different')});
 assert.equal(r.reason,'MULTIPAGE_REDIRECT_OR_ORIGIN_MISMATCH');
});
