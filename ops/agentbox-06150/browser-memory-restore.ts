/** Restore only the one changed Memory Saver preference, never profile/userdata. */
import {readFileSync} from 'node:fs';
const saved=JSON.parse(readFileSync('/home/agent/.local/state/omg-update-backups/browser-memory-20260930/before.json','utf8'));
const value=saved.prefs.find((p:any)=>p.key==='performance_tuning.high_efficiency_mode.state').value;
const version=await(await fetch('http://127.0.0.1:9280/json/version')).json();const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pending=new Map();ws.onmessage=e=>{const x=JSON.parse(String(e.data));const p=pending.get(x.id);if(p){pending.delete(x.id);clearTimeout(p.t);x.error?p.j(new Error(x.error.message)):p.r(x.result)}};
function call(method:string,params:any={},sessionId?:string):Promise<any>{return new Promise((r,j)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);j(new Error('CDP timeout '+method))},15000);pending.set(id,{r,j,t});ws.send(JSON.stringify({id,method,params,sessionId}))})}
const t=await call('Target.createTarget',{url:'chrome://settings/performance',background:true});
try{const s=await call('Target.attachToTarget',{targetId:t.targetId,flatten:true});await new Promise(r=>setTimeout(r,2200));const x=await call('Runtime.evaluate',{expression:`new Promise(resolve=>chrome.settingsPrivate.setPref('performance_tuning.high_efficiency_mode.state',${JSON.stringify(value)},'',ok=>resolve(ok)))`,awaitPromise:true,returnByValue:true},s.sessionId);if(x.result.value!==true)throw new Error('Preference restore failed');console.log('MEMORY_SAVER_PREF_RESTORED')}finally{await call('Target.closeTarget',{targetId:t.targetId});ws.close()}
