import assert from 'node:assert/strict';
import {test} from 'node:test';
import {routeOrdinaryTabTask} from './ordinary-bridge.mjs';

const tab_id=1234567;
const target_url='https://www.selenium.dev/selenium/web/web-form.html';
const request_id='ordinary:1234567:recoveryFixture';
const snapshot=(url=target_url)=>({status:'PASS',result:{
  source:'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT',
  age_seconds:0,truncated:false,tabs:[{id:tab_id,url}]
}});
const success={status:'PASS',result:{step_results:[{action:'READ_TITLE',pass:true,value:'Web form'}]}};
const read=[{action:'READ_TITLE'}];
const click=[{action:'CLICK',locator:{kind:'role',role:'button',name:'Submit'}}];
async function run(queue, overrides={}) {
  let n=0;
  const calls=[];
  const sendDeviceJob=async (_device,op,input)=>{
    calls.push({op,input});
    const expected=queue[n++];
    assert.ok(expected,'unexpected operation '+op);
    assert.equal(op,expected.op);
    if(expected.reject)throw new Error('relay disconnected');
    return expected.result;
  };
  const result=await routeOrdinaryTabTask({
    request_id,target_url,steps:read,allowWrites:false,
    deviceId:'fixture',sendDeviceJob,pause:async()=>{},...overrides
  });
  assert.equal(n,queue.length,'mock queue not fully used');
  return {result,calls};
}
const S=(result=snapshot())=>({op:'NORMAL_TABS_SNAPSHOT',result});
const A=(result=success)=>({op:'NORMAL_TAB_ACTION',result});

test('unchanged read succeeds',async()=>{
  const {result,calls}=await run([S(),A()]);
  assert.equal(result.status,'PASS');
  assert.equal(calls.length,2);
  assert.equal(result.result.route,'ORDINARY_BRAVE_EXISTING_TAB');
});
test('transient snapshot failure recovers before dispatch',async()=>{
  const {result,calls}=await run([S({status:'FAILED',reason:'TAB_SNAPSHOT_REFRESH_TIMEOUT'}),S(),A()]);
  assert.equal(result.status,'PASS');
  assert.equal(calls.filter(x=>x.op==='NORMAL_TAB_ACTION').length,1);
});
test('read retry has a new local ID to bypass cached failure',async()=>{
  const {result,calls}=await run([S(),A({status:'FAILED',reason:'INJECTION_FAILED: stale'}),S(),A()]);
  assert.equal(result.status,'PASS');
  assert.equal(result.read_attempts,2);
  assert.notEqual(calls[1].input.request_id,calls[3].input.request_id);
});
test('URL changes prevent retry on different page',async()=>{
  const {result,calls}=await run([S(),A({status:'TIMEOUT'}),S(snapshot('https://elsewhere.example/'))]);
  assert.equal(result.reason,'ORDINARY_TAB_URL_MISMATCH');
  assert.equal(calls.length,3);
});
test('ambiguous or blocked read errors are not retried',async()=>{
  const {result,calls}=await run([S(),A({status:'BLOCKED',reason:'SECRET_FIELD'})]);
  assert.equal(result.status,'BLOCKED');
  assert.equal(calls.length,2);
});
test('timeout after write dispatch stays uncertain without second dispatch',async()=>{
  const {result,calls}=await run([S(),A({status:'FAILED',reason:'EXTENSION_TIMEOUT'})],{
    steps:click,allowWrites:true
  });
  assert.equal(result.status,'UNCERTAIN');
  assert.equal(result.retry_safe,false);
  assert.equal(calls.filter(x=>x.op==='NORMAL_TAB_ACTION').length,1);
});
test('write success remains backward compatible',async()=>{
  const {result,calls}=await run([S(),A()],{steps:click,allowWrites:true});
  assert.equal(result.status,'PASS');
  assert.equal(calls[1].input.request_id,request_id);
});
test('ordinary routing never changes legacy requests',async()=>{
  const {result,calls}=await run([],{request_id:'legacy-request-id'});
  assert.equal(result,null);
  assert.equal(calls.length,0);
});
