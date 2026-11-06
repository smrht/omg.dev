// Screenshots van de staging-UI via agentbox-test-browser (vers profiel, geen login).
// Gebruik: agentbox-test-browser --run-test bun shot.ts <url> <uit-prefix> [js-na-laden]
// Maakt <prefix>-desktop.png (1440x900) en <prefix>-mobiel.png (390x844), licht en donker via SCHEME=dark.
const cdp = process.env.AGENTBOX_TEST_CDP!;
const [url, prefix, extraJs = ""] = process.argv.slice(2);
const scheme = process.env.SCHEME ?? "light";
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
for (const [naam, w, h, mobiel] of [["desktop", 1440, 900, false], ["mobiel", 390, 844, true]] as const) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobiel ? 2 : 1, mobile: mobiel }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobiel }, s);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: process.env.MOTION ? "no-preference" : "reduce" }] }, s);
  await send("Page.navigate", { url }, s); await sleep(2500);
  await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
  await send("Page.navigate", { url }, s);
  for (let t = 0; t < 40; t++) {
    await sleep(500);
    const ok = await ev(`document.querySelectorAll("[data-overview-row]").length > 0 && !document.body.innerText.includes("Connecting")`);
    if (ok) break;
  }
  await sleep(800);
  if (extraJs) { const uit = await ev(`(async()=>{${extraJs}})()`); await sleep(1500); if (uit !== undefined) console.log("extra", JSON.stringify(uit)); }
  const maat = await ev(`(() => { const rows=[...document.querySelectorAll("[data-overview-row]")]; const vis=rows.filter(r=>{const b=r.getBoundingClientRect();return b.height>0&&b.top>=0&&b.bottom<=innerHeight}); const first=rows[0]?.getBoundingClientRect().top??-1; const comp=document.querySelector("[data-testid=new-session-stage] form, [data-testid=new-session-stage] textarea")?.closest("form")?.getBoundingClientRect().height??-1; return {rijenZichtbaar:vis.length, rijHoogte:Math.round(rows[0]?.getBoundingClientRect().height??0), eersteRijTop:Math.round(first), composerHoogte:Math.round(comp), connecting:document.body.innerText.includes("Connecting")}; })()`);
  console.log(naam, JSON.stringify(maat));
  const shot = await send("Page.captureScreenshot", { format: "png" }, s);
  await Bun.write(`${prefix}-${naam}.png`, Buffer.from(shot.result.data, "base64"));
  console.log(`${prefix}-${naam}.png`);
}
await send("Target.closeTarget", { targetId }); ws.close(); process.exit(0);
