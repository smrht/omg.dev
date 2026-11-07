// Beeld-voor-beeld opname van een UI-overgang (mobiel 390x844) via CDP-screencast.
// Gebruik: agentbox-test-browser --run-test bun cast.ts <url> <uit-prefix> <js-voorbereiding> <js-actie>
const cdp = process.env.AGENTBOX_TEST_CDP!;
const [url, prefix, prep, actie] = process.argv.slice(2);
const list = await (await fetch(`${cdp}/json/version`)).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0; const wait = new Map<number, (v: any) => void>(); const frames: { t: number; data: string }[] = [];
let sess = "";
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data));
  if (m.id && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); }
  if (m.method === "Page.screencastFrame") { frames.push({ t: performance.now(), data: m.params.data }); ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId }, sessionId: sess })); } });
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId: s } } = await send("Target.attachToTarget", { targetId, flatten: true }); sess = s;
await send("Page.enable", {}, s); await send("Runtime.enable", {}, s);
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, s)).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
await send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.SCHEME ?? "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }] }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(4000);
console.log("prep", JSON.stringify(await ev(`(async()=>{${prep}})()`)));
await send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, s);
await sleep(400);
const t0 = performance.now();
console.log("actie", JSON.stringify(await ev(`(async()=>{${actie}})()`)));
await sleep(Number(process.env.DUUR ?? 1200));
await send("Page.stopScreencast", {}, s);
let n = 0;
for (const f of frames) { if (f.t < t0 - 100) continue; await Bun.write(`${prefix}-${String(n).padStart(3, "0")}-${Math.round(f.t - t0)}ms.jpg`, Buffer.from(f.data, "base64")); n++; }
console.log("frames", n);
await send("Target.closeTarget", { targetId }); ws.close(); process.exit(0);
