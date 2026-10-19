import {canonicalOrdinaryUrl} from './ordinary-bridge.mjs';

// Explicit same-origin batch reads via the existing S9 READ_TEXT schema.
// A public hidden-browser operation, never an ordinary authenticated-tab action.
const REQUEST_RE=/^batch:[A-Za-z0-9._-]{8,80}$/;
const NAME_RE=/^SELFISH_BATCH_(TEXT|LINKS)_CHUNK_([0-9]{3})_([A-Za-z0-9_-]{1,78})$/;
const SAFE_KEYS=new Set(['id','course','section','page','categoryid','moduleid','cmid']);
const MUTATING=/^(?:logout|signout|delete|remove|revoke|checkout|purchase|submit|unsubscribe|enroll|unenroll|withdraw|cancel|approve|reject|reset|destroy|pay|charge|execute)$/i;
const blocked=reason=>({status:'BLOCKED',reason});
const CHARS=2048;

export function encodeBatchPath(path){return Buffer.from(path,'utf8').toString('base64url');}

export function validateBatchTarget(baseUrl,encodedPath){
 try{
  const base=new URL(baseUrl);
  if(!canonicalOrdinaryUrl(baseUrl)||base.search||base.hash)return null;
  const path=Buffer.from(encodedPath,'base64url').toString('utf8');
  if(encodeBatchPath(path)!==encodedPath||!path.startsWith('/')||path.startsWith('//')||/[\u0000-\u001f\u007f#\\]/.test(path))return null;
  const decodedPath=decodeURIComponent(path.split('?')[0]);
  if(decodedPath.split('/').some(x=>x==='..'||x==='.'||MUTATING.test(x)))return null;
  const dest=new URL(path,base.origin);
  if(dest.origin!==base.origin||dest.username||dest.password||dest.hash||!canonicalOrdinaryUrl(dest.href))return null;
  for(const [key,value] of dest.searchParams){
   if(!SAFE_KEYS.has(key.toLowerCase())||!/^\d{1,12}$/.test(value))return null;
  }
  return dest.href.length<=512?dest.href:null;
 }catch{return null;}
}

export function parseBatchStep(step,baseUrl){
 if(step?.action!=='READ_TEXT'||step.locator?.kind!=='role'||step.locator.role!=='link'||step.max_chars!==CHARS)return null;
 const m=NAME_RE.exec(step.locator.name||'');
 if(!m)return null;
 const url=validateBatchTarget(baseUrl,m[3]);
 return url&&Number(m[2])<=31?{kind:m[1],index:Number(m[2]),url}:null;
}

function getSteps(response){
 const r=response?.result;
 return r?.result?.step_results??r?.step_results??null;
}

export async function routeMultiPageBatch({request_id,target_url,steps,sendDeviceJob,deviceId}){
 if(typeof request_id!=='string'||!request_id.startsWith('batch:'))return null;
 if(!REQUEST_RE.test(request_id)||!canonicalOrdinaryUrl(target_url))return blocked('INVALID_MULTIPAGE_REQUEST');
 if(!Array.isArray(steps)||steps.length<1||steps.length>8)return blocked('INVALID_MULTIPAGE_STEPS');
 const parsed=steps.map(s=>parseBatchStep(s,target_url));
 if(parsed.some(x=>!x))return blocked('INVALID_MULTIPAGE_TARGET_OR_STEP');
 const pages=[...new Set(parsed.map(x=>x.url))];
 if(pages.length>3)return blocked('MULTIPAGE_PAGE_LIMIT');
 const byUrl=new Map();
 for(const item of parsed){
  const arr=byUrl.get(item.url)||[];
  if(!arr.some(x=>x.kind===item.kind&&x.index===item.index))arr.push(item);
  byUrl.set(item.url,arr);
 }
 if([...byUrl.values()].some(reads=>reads.length>6))return blocked('MULTIPAGE_PER_PAGE_STEP_LIMIT');
 const results=new Map();
 for(const [pageNo,[url,reads]] of [...byUrl.entries()].entries()){
  const readSteps=reads.map(item=>({
   action:'READ_TEXT',
   locator:{kind:'role',role:'link',name:'SELFISH_'+(item.kind==='TEXT'?'PAGE_TEXT':'LIST_LINKS')+'_CHUNK_'+String(item.index).padStart(3,'0')},
   max_chars:CHARS
  }));
  const job={request_id:request_id+'.page_'+pageNo,target_url:url,side_effect_approval:false,steps:[{action:'NAVIGATE'},{action:'READ_TITLE'},...readSteps]};
  let response;
  try{response=await sendDeviceJob(deviceId,'PUBLIC_BROWSER_TASK',job,25000);}
  catch{return {status:'DEVICE_DISCONNECTED',reason:'MULTIPAGE_DEVICE_JOB_FAILED',pages_completed:pageNo};}
  if(response?.status!=='PASS')return {status:response?.status||'FAILED',reason:response?.reason||'MULTIPAGE_PAGE_FAILED',pages_completed:pageNo};
  const finalUrl=response?.result?.result?.final_url??response?.result?.final_url;
  try{
   if(typeof finalUrl!=='string'||new URL(finalUrl).href!==new URL(url).href)return blocked('MULTIPAGE_REDIRECT_OR_ORIGIN_MISMATCH');
  }catch{return blocked('MULTIPAGE_INVALID_FINAL_URL');}
  const seen=getSteps(response);
  if(!Array.isArray(seen)||seen.length!==job.steps.length||seen.some(s=>s.pass!==true))return blocked('MULTIPAGE_INCOMPLETE_WORKER_RESULT');
  const title=seen[1]?.value;
  for(let i=0;i<reads.length;i++){
   const item=reads[i], sr=seen[i+2];
   if(sr.source!==(item.kind==='TEXT'?'VISIBLE_PAGE_TEXT':'VISIBLE_PAGE_LINKS')||sr.chunk_index!==item.index||typeof sr.value!=='string'||sr.value.length>CHARS)return blocked('MULTIPAGE_UNEXPECTED_WORKER_RESULT');
   results.set(url+'|'+item.kind+'|'+item.index,{...sr,page_url:url,page_title:typeof title==='string'?title.slice(0,256):null});
  }
 }
 return {status:'PASS',result:{
  route:'PUBLIC_MULTIPAGE_READ_ONLY',state:'COMPLETED',read_only:true,
  pages_processed:pages.length,steps_completed:steps.length,
  step_results:parsed.map((item,i)=>({index:i,action:'READ_TEXT',pass:true,...results.get(item.url+'|'+item.kind+'|'+item.index)}))
 }};
}
