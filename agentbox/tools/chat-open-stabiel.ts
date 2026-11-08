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
const rijen = (process.env.RIJ ?? "2").split(",").map(Number);
for (const rij of rijen) for (let k = 0; k < Number(process.env.RONDES ?? 2); k++) {
  const r = await ev(`new Promise(res=>{const t0=performance.now();const rows=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent);const naam=rows[${rij}]?.textContent.slice(0,24);rows[${rij}].click();const sp=[];let eerste=-1;
    (function f(){const d=document.querySelector('[role=dialog][aria-modal=true]');const rs=d?[...d.querySelectorAll('[data-index]')]:[];
      if(rs.length){if(eerste<0)eerste=Math.round(performance.now()-t0);let sc=rs[0].parentElement;while(sc&&!(sc.scrollHeight>sc.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(sc).overflowY)))sc=sc.parentElement;
        const last=rs.reduce((a,b)=>Number(b.dataset.index)>Number(a.dataset.index)?b:a);const zicht=rs.filter(e=>{const b=e.getBoundingClientRect();return b.bottom>0&&b.top<innerHeight}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
        sp.push([Math.round(performance.now()-t0),Math.round(last.getBoundingClientRect().bottom),sc?Math.round(sc.scrollHeight-sc.scrollTop-sc.clientHeight):null,zicht?zicht.dataset.index+'@'+Math.round(zicht.getBoundingClientRect().top):null]);}
      if(performance.now()-t0<2000)requestAnimationFrame(f);else res({naam,eerste,sp});})()})`);
  // sprongen: veranderingen in de onderste-rij-positie of de bovenste zichtbare rij, na eerste inhoud
  const sp = r.sp; let spr = 0; const lijst: string[] = [];
  for (let i = 1; i < sp.length; i++) if (sp[i][1] !== sp[i-1][1] || sp[i][3] !== sp[i-1][3]) { spr++; if (lijst.length < 8) lijst.push(`${sp[i][0]}:${sp[i-1][1]}->${sp[i][1]} ${sp[i-1][3]}->${sp[i][3]} bodem${sp[i][2]}`); }
  const mm = await ev(`performance.getEntriesByType("resource").filter(e=>/mermaid|katex|math/.test(e.name)).map(e=>e.name.split("/").pop().slice(0,20)).join(",")`); console.log(`rij ${rij} ${r.naam} [${mm}] | inhoud ${r.eerste} ms | sprongen ${spr} | eind-bodemafstand ${sp.at(-1)?.[2]} | ${lijst.join(" ; ")}`);
  await ev(`document.querySelector('[role=dialog] button[aria-label="Close session details"]')?.click()`); await sleep(1200);
}
await send("Target.closeTarget", { targetId });
process.exit(0);
