import {mkdirSync,writeFileSync,copyFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='/home/agent/.local/state/omg-update-backups/browser-memory-20260930';mkdirSync(root,{recursive:true,mode:0o700});
const version=await (await fetch('http://127.0.0.1:9280/json/version')).json();const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pending=new Map();ws.onmessage=e=>{const x=JSON.parse(String(e.data));const p=pending.get(x.id);if(p){pending.delete(x.id);clearTimeout(p.t);x.error?p.j(new Error(x.error.message)):p.r(x.result)}};
function call(method:string,params:any={},sessionId?:string):Promise<any>{return new Promise((r,j)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);j(new Error('CDP timeout '+method))},15000);pending.set(id,{r,j,t});ws.send(JSON.stringify({id,method,params,sessionId}))})}
let ownTarget:string|undefined;
const profile='/home/agent/.omg/computer/chrome-profile';
function memory(){const slice='/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/computer.slice';return Number(readFileSync(slice+'/memory.current','utf8'))}
try{
 const before=(await call('Target.getTargets')).targetInfos.filter((x:any)=>x.type==='page');
 // Private local restore metadata only. Never print URLs, titles, cookies or storage.
 if(existsSync(root+'/before.json'))throw new Error('Baseline exists; refuse to replace');
 for(const f of ['Local State','Default/Preferences'])if(existsSync(profile+'/'+f)){copyFileSync(profile+'/'+f,root+'/'+f.replaceAll('/','_'));}
 mkdirSync(root+'/Sessions',{mode:0o700});for(const n of readdirSync(profile+'/Default/Sessions'))copyFileSync(profile+'/Default/Sessions/'+n,root+'/Sessions/'+n);
 const beforeBytes=memory();
 const t=await call('Target.createTarget',{url:'chrome://settings/performance',background:true});ownTarget=t.targetId;
 const s=await call('Target.attachToTarget',{targetId:t.targetId,flatten:true});await new Promise(r=>setTimeout(r,2200));
 const prefs=await call('Runtime.evaluate',{expression:`new Promise(resolve=>chrome.settingsPrivate.getAllPrefs(p=>resolve(p.filter(x=>/high_efficiency_mode/.test(x.key)))))`,awaitPromise:true,returnByValue:true},s.sessionId);
 if(prefs.exceptionDetails||!Array.isArray(prefs.result.value))throw new Error('Preference read failed');
 const baseline={beforeBytes,targets:before.map((x:any)=>({id:x.targetId,url:x.url})),prefs:prefs.result.value};writeFileSync(root+'/before.json',JSON.stringify(baseline),{mode:0o600});
 const state=prefs.result.value.find((p:any)=>p.key==='performance_tuning.high_efficiency_mode.state');if(!state||state.value!==0)throw new Error('Memory Saver baseline drift');
 const applied=await call('Runtime.evaluate',{expression:`new Promise(resolve=>chrome.settingsPrivate.setPref('performance_tuning.high_efficiency_mode.state',2,'',ok=>resolve(ok)))`,awaitPromise:true,returnByValue:true},s.sessionId);if(applied.result.value!==true)throw new Error('Memory Saver save rejected');
 const readback=await call('Runtime.evaluate',{expression:`new Promise(resolve=>chrome.settingsPrivate.getPref('performance_tuning.high_efficiency_mode.state',p=>resolve(p.value)))`,awaitPromise:true,returnByValue:true},s.sessionId);if(readback.result.value!==2)throw new Error('Memory Saver readback failed');
 await call('Target.closeTarget',{targetId:t.targetId});ownTarget=undefined;
 // Garbage collection removes unreachable objects only. No tab unload or forced discard.
 let collected=0,unavailable=0;for(const x of before){let sessionId;try{sessionId=(await call('Target.attachToTarget',{targetId:x.targetId,flatten:true})).sessionId;await call('HeapProfiler.collectGarbage',{},sessionId);collected++}catch{unavailable++}finally{if(sessionId)await call('Target.detachFromTarget',{sessionId})}}
 const after=(await call('Target.getTargets')).targetInfos.filter((x:any)=>x.type==='page');const absent=before.filter((x:any)=>!after.some((a:any)=>a.targetId===x.targetId));if(absent.length)throw new Error('User tab missing; investigate');
 const result={beforeGiB:beforeBytes/2**30,afterGiB:memory()/2**30,beforeTabs:before.length,preservedTabs:before.length,afterTabs:after.length,memorySaver:2,collected,unavailable};writeFileSync(root+'/result.json',JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));
}finally{if(ownTarget)await call('Target.closeTarget',{targetId:ownTarget});ws.close()}
