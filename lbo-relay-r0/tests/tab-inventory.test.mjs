import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeTabInventoryRead, TAB_INVENTORY_URL} from '../tab-inventory.mjs';

const name=i=>`SELFISH_TAB_LIST_CHUNK_${String(i).padStart(3,'0')}`;
const mk=(i=0)=>({request_id:'tabs:test00000001',target_url:TAB_INVENTORY_URL,steps:[{action:'READ_TEXT',locator:{kind:'role',role:'link',name:name(i)},max_chars:2048}],deviceId:'test'});
const tabs=Array.from({length:15},(_,i)=>({id:i+1,active:i===1,title:`Course ${i}`,url:`https://courses.example.org/course/view.php/id/${i}`}));
const fake=(a=tabs, opts={})=>async()=>({status:'PASS',result:{source:'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT',age_seconds:0,received_at:'2026-10-19T01:00:00Z',count:a.length,truncated:false,tabs:a,...opts}});

test('non-inventory requests fall back to normal S9 workflow',async()=>assert.equal(await routeTabInventoryRead({...mk(),request_id:'ordinary:1:someopaque123',sendDeviceJob:fake()}),null));
test('invalid inventory requests never dispatch a worker job',async()=>{
  for(const args of [
    {...mk(),request_id:'tabs:short'},
    {...mk(),target_url:'https://example.org/'},
    {...mk(),steps:[{action:'NAVIGATE'}]},
    {...mk(),steps:[{action:'READ_TEXT',locator:{kind:'role',role:'link',name:'other'},max_chars:2048}]},
    {...mk(),steps:[{action:'READ_TEXT',locator:{kind:'role',role:'link',name:name(0)},max_chars:4096}]},
    {...mk(),steps:[...mk().steps,...mk().steps]},
    {...mk(),steps:[{action:'CLICK'}]}
  ]) assert.equal((await routeTabInventoryRead({...args,sendDeviceJob:async()=>{throw Error('SHOULD_NOT_CALL');}})).status,'BLOCKED');
});
test('fresh snapshot produces a bounded chunk with continuation',async()=>{
  let call;
  const r=await routeTabInventoryRead({...mk(),sendDeviceJob:async(...args)=>{call=args;return fake()();}});
  assert.deepEqual(call.slice(1),['NORMAL_TABS_SNAPSHOT',{limit:100},15000]);
  assert.equal(r.status,'PASS');
  assert.equal(r.result.step_results[0].next_chunk,1);
  assert.equal((r.result.step_results[0].value.match(/Course/g)||[]).length,8);
  assert.equal(r.result.eligible_tabs,15);
});
test('second chunk completes and preserves fingerprint',async()=>{
  const a=await routeTabInventoryRead({...mk(0),sendDeviceJob:fake()});
  const b=await routeTabInventoryRead({...mk(1),sendDeviceJob:fake()});
  assert.equal(b.result.step_results[0].next_chunk,null);
  assert.equal(a.result.snapshot_fingerprint,b.result.snapshot_fingerprint);
  assert.match(b.result.step_results[0].value,/Course 14/);
});
test('private URLs excluded and auth query parameters are never exposed',async()=>{
  const r=await routeTabInventoryRead({...mk(),sendDeviceJob:fake([
    {id:1,title:'Secret',url:'http://127.0.0.1:3000/'},
    {id:2,title:'Local',url:'https://localhost/'},
    {id:3,title:'Browser',url:'brave://extensions'},
    {id:4,title:'Query',url:'https://example.org/course?id=2&token=TOPSECRET#fragment'},
    {id:5,title:'Safe',url:'https://example.org/course',active:true}
  ])});
  assert.equal(r.result.eligible_tabs,2);
  assert.doesNotMatch(JSON.stringify(r),/TOPSECRET|Local|Secret|Browser/);
});
test('stale, cached or truncated snapshots fail closed',async()=>{
  for(const opts of [{age_seconds:11},{source:'CACHED_EXISTING_BRAVE_EXTENSION_SNAPSHOT'},{truncated:true},{tabs:null}]) {
    assert.equal((await routeTabInventoryRead({...mk(),sendDeviceJob:fake(tabs,opts)})).status,'BLOCKED');
  }
});
test('device outage and errors do not fabricate success',async()=>{
  assert.equal((await routeTabInventoryRead({...mk(),sendDeviceJob:async()=>({status:'DEVICE_OFFLINE'})})).status,'DEVICE_OFFLINE');
  assert.equal((await routeTabInventoryRead({...mk(),sendDeviceJob:async()=>{throw Error('offline');}})).status,'DEVICE_DISCONNECTED');
});
test('maximum title and URLs cannot exceed existing 2048-char result size',async()=>{
  const long=Array.from({length:100},(_,i)=>({id:i+1,title:'X'.repeat(300),url:`https://example.org/${'a'.repeat(200)}`}));
  const r=await routeTabInventoryRead({...mk(10),sendDeviceJob:fake(long)});
  assert.equal(r.status,'PASS');
  assert.ok(r.result.step_results[0].value.length<=2048);
  assert.ok(r.result.step_results[0].next_chunk!==null);
});