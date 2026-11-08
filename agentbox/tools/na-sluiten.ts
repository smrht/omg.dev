// Wat verandert er op het overzicht in de 5 s na terug uit een chat (animaties, scroll, DOM-mutaties).
const cdp = process.env.AGENTBOX_TEST_CDP!;
const [url] = process.argv.slice(2);
const list = await (await fetch(`${cdp}/json/version`)).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0; const wait = new Map<number, (v: any) => void>();
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.id && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); } });
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId: s } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, s); await send("Runtime.enable", {}, s);
const ev = async (expr: string) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, s); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
await send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(6000);
await ev(`(async()=>{const rows=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent); rows[Number("${process.env.PICK ?? 2}")].click();
  for(let i=0;i<200;i++){ if(document.querySelector("[data-session-ready=true]")) break; await new Promise(r=>setTimeout(r,50)); } await new Promise(r=>setTimeout(r,2500)); })()`);
if (process.env.TIKTEST) {
  await ev(`history.back(); 1`); await sleep(1000);
  const pos = await ev(`(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[1].getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if (process.env.TIKTEST === "veeg") {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pos] }, s);
    for (let i = 1; i <= 10; i++) { await sleep(20); await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pos.x, y: pos.y - i * 15 }] }, s); }
  } else { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pos] }, s); }
  await sleep(80);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s); await sleep(5000);
  console.log("tiktest klaar", JSON.stringify(pos)); await send("Target.closeTarget", { targetId }); process.exit(0);
}
const out = await ev(`(async()=>{
  const naam=(el)=>{ if(!el||!el.tagName) return String(el); const c=(el.getAttribute&&el.getAttribute('class')||'').split(' ').slice(0,3).join('.'); const d=[...(el.attributes||[])].filter(a=>a.name.startsWith('data-')).map(a=>a.name).slice(0,2).join(','); return el.tagName.toLowerCase()+(c?'.'+c:'')+(d?'['+d+']':''); };
  const mut={}; let nm=0;
  const mo=new MutationObserver(l=>{ for(const m of l){ nm++; const k=(performance.now()-t0<1000?'0-1s':performance.now()-t0<2500?'1-2.5s':'2.5-5s')+' '+m.type+' '+naam(m.target)+(m.attributeName?' @'+m.attributeName:''); mut[k]=(mut[k]||0)+1; } });
  mo.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  const sc=[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight;});
  const t0=performance.now(); history.back();
  const samples=[];
  for(let t=0;t<5000;t+=250){ await new Promise(r=>setTimeout(r,250));
    const an=document.getAnimations().filter(a=>a.playState==='running').map(a=>naam(a.effect&&a.effect.target)+':'+(a.animationName||a.transitionProperty||'waapi'));
    samples.push({t:Math.round(performance.now()-t0), anim:an.slice(0,6), nAnim:an.length, scroll:[...document.querySelectorAll('*')].filter(e=>e.scrollTop>0).map(e=>naam(e)+'='+Math.round(e.scrollTop)).slice(0,3), win:Math.round(scrollY)}); }
  mo.disconnect();
  const top=Object.entries(mut).sort((a,b)=>b[1]-a[1]).slice(0,30);
  return JSON.stringify({nm, samples, top, path:location.pathname},null,1);
})()`);
console.log(out);
await send("Target.closeTarget", { targetId });
process.exit(0);
