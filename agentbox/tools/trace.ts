// CPU-profiel van de staging-UI tijdens scrollen (agentbox-test-browser).
// Gebruik: agentbox-test-browser --run-test bun prof.ts <url>
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
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, s)).result?.result?.value;
const mob = !!process.env.MOBIEL;
await send("Emulation.setDeviceMetricsOverride", mob ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
if (mob) await send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(6000);
const mode = process.env.MODE ?? "scroll";
if (mode === "close") {
  // open first, outside the profile; then profile only the close
  await ev(`(async()=>{const rows=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent); (rows.find(r=>r.textContent.includes("${process.env.PICKTEXT ?? "@@"}")) ?? rows[Number("${process.env.PICK ?? 3}")]).click();
    for(let i=0;i<200;i++){ if(document.querySelector("[data-session-ready=true]")) break; await new Promise(r=>setTimeout(r,50)); } await new Promise(r=>setTimeout(r,1500)); })()`);
}
if (process.env.THROTTLE) await send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) }, s);
const evs: any[] = [];
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.method === "Tracing.dataCollected") evs.push(...m.params.value); });
const klaar = new Promise(r => ws.addEventListener("message", e => { if (JSON.parse(String(e.data)).method === "Tracing.tracingComplete") r(0); }));
await send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink", transferMode: "ReportEvents" });
await ev(`(async()=>{ document.querySelector('[role=dialog] button[aria-label="Close session details"]').click(); await new Promise(r=>setTimeout(r,${process.env.WACHT ?? 3000})); })()`);
await send("Tracing.end"); await klaar;
const agg = new Map<string, [number, number]>();
for (const e of evs) if (e.ph === "X" && e.dur) { const k = e.name; const v = agg.get(k) ?? [0, 0]; v[0] += e.dur; v[1]++; agg.set(k, v); }
for (const [k, [d, n]] of [...agg].sort((a, b) => b[1][0] - a[1][0]).slice(0, 25)) console.log(Math.round(d / 1000), "ms", n + "x", k);
const t0 = Math.min(...evs.filter(e => e.ts).map(e => e.ts));
const lang = evs.filter(e => e.name === "RunTask" && e.dur > 30000).sort((a, b) => a.ts - b.ts);
for (const e of lang) {
  const kids = evs.filter(k => k.ts >= e.ts && k.ts < e.ts + e.dur && k.dur > 8000 && k.name !== "RunTask" && k.tid === e.tid).sort((a, b) => b.dur - a.dur).slice(0, 4).map(k => `${k.name}${k.args?.data?.functionName ? ":" + k.args.data.functionName : ""}${k.args?.data?.type ? ":" + k.args.data.type : ""} ${Math.round(k.dur / 1000)}`);
  console.log("LANG +" + Math.round((e.ts - t0) / 1000), Math.round(e.dur / 1000) + "ms", kids.join(" | "));
}
const lay = evs.filter(e => e.name === "Layout" && e.dur).sort((a, b) => b.dur - a.dur).slice(0, 5);
for (const e of lay) console.log("Layout", Math.round(e.dur / 1000), JSON.stringify(e.args?.beginData ?? {}).slice(0, 200));
const rs = evs.filter(e => (e.name === "UpdateLayoutTree" || e.name === "RecalculateStyles") && e.dur).sort((a, b) => b.dur - a.dur).slice(0, 5);
for (const e of rs) console.log("Style", Math.round(e.dur / 1000), JSON.stringify(e.args?.elementCount ?? e.args?.beginData ?? {}).slice(0, 200));
await send("Target.closeTarget", { targetId });
process.exit(0);
