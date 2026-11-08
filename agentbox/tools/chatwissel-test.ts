// Opent een chat (mobiel) en volgt per frame of de inhoud stil staat: positie van de
// onderste berichtrij, scrollTop en afstand tot de bodem. Plus tik->inhoud.
// Gebruik: agentbox-test-browser --run-test bun chat-open-stabiel.ts <url>   (RIJ=index, RONDES=n)
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
await send("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 3, mobile: true }, s);
await send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
await send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }] }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(7000);

// Andere overgangen op mobiel: tabs in het overzicht, zoeken, menu. Per actie frame-gaten 1,2 s.
const meet = async (naam: string, actie: string) => {
  const r = await ev(`new Promise(res=>{const lt=[];const po=new PerformanceObserver(l=>{for(const e of l.getEntries())lt.push(Math.round(e.duration))});po.observe({type:'longtask'});const t0=performance.now();let v=t0,g=0,n=0;const ok=(()=>{${actie}})();const f=(t)=>{n++;g=Math.max(g,t-v);v=t;if(t-t0<1200)requestAnimationFrame(f);else{po.disconnect();res(JSON.stringify({ok,g:Math.round(g),n,lt}))}};requestAnimationFrame(f)})`);
  console.log("actie", naam, typeof r === "string" ? r : JSON.stringify(r));
  await sleep(600);
};

const tik = (type: string, x: number, y: number) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] }, s);
await ev(`(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2]; r.click(); return 1})()`);
await sleep(2500);
for (let k = 0; k < 3; k++) {
  await ev(`window.__g=0;window.__lt=[];window.__po=new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(Math.round(e.duration))});window.__po.observe({type:'longtask'});window.__t0=performance.now();(function(){let v=performance.now();const f=t=>{window.__g=Math.max(window.__g,t-v);v=t;if(t-window.__t0<1800)requestAnimationFrame(f)};requestAnimationFrame(f)})();window.__titel=document.querySelector('[role=dialog][aria-modal=true]')?.getAttribute('aria-label');window.__sp=[];(function g(){const b=document.querySelector('[role=dialog][aria-modal=true] .flex.min-h-0.flex-1.flex-col');const t=performance.now()-window.__t0;if(b){const cs=getComputedStyle(b);window.__sp.push(Math.round(t)+':'+Number(cs.opacity).toFixed(2)+'/'+Math.round(new DOMMatrix(cs.transform).m41))}if(t<1500)requestAnimationFrame(g)})();1`);
  const y = Number(process.env.Y ?? 500); const links = k % 2 === 0; await tik("touchStart", links ? 330 : 60, y);
  for (let i = 1; i <= 8; i++) { await tik("touchMove", links ? 330 - i * 30 : 60 + i * 30, y + 3); await sleep(16); }
  await tik("touchEnd", 0, 0);
  await sleep(1900);
  console.log("chatwissel", await ev(`JSON.stringify({van:window.__titel?.slice(0,20),naar:document.querySelector('[role=dialog][aria-modal=true]')?.getAttribute('aria-label')?.slice(0,20),maxGat:Math.round(window.__g),lt:window.__lt,sp:window.__sp.filter((x,i)=>i%2==0).slice(0,40).join(' ')})`));
}
await send("Target.closeTarget", { targetId });
process.exit(0);
