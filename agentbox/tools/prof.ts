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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(6000);
await send("Profiler.enable", {}, s); await send("Profiler.setSamplingInterval", { interval: 200 }, s);
await send("Profiler.start", {}, s);
const mode = process.env.MODE ?? "scroll";
await ev(`(async()=>{const sc=[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight+50&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];
 if("${mode}"==="idle"){await new Promise(r=>setTimeout(r,5000));return}
 for(let i=0;i<60;i++){ if(sc) sc.scrollTop = (i%2? 0 : sc.scrollHeight); await new Promise(r=>setTimeout(r,60)); } })()`);
const { result: { profile } } = await send("Profiler.stop", {}, s);
const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
const self = new Map<number, number>();
const dts = profile.timeDeltas; for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dts[i] ?? 0));
const agg = new Map<string, number>(); let total = 0;
for (const [nid, t] of self) { const n: any = byId.get(nid); const cf = n.callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}`; agg.set(k, (agg.get(k) ?? 0) + t); total += t; }
// inclusieve tijd per functie
const parent = new Map<number, number>(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map<string, number>();
for (const [nid, t] of self) { const seen = new Set<string>(); let cur: number | undefined = nid; while (cur) { const cf = (byId.get(cur) as any).callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}`; if (!seen.has(k)) { incl.set(k, (incl.get(k) ?? 0) + t); seen.add(k); } cur = parent.get(cur); } }
console.log("totaal ms", Math.round(total / 1000));
console.log("SELF"); for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(Math.round(v / 1000), k);
console.log("INCL"); for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(Math.round(v / 1000), k);
await send("Target.closeTarget", { targetId });
process.exit(0);
