// Desktop: klik "Opdracht geven" in Voor jou en kijk welke composer de tekst kreeg.
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(7000);
const ta = `JSON.stringify([...document.querySelectorAll("textarea")].map(t=>({ph:t.placeholder.slice(0,30), zichtbaar:t.offsetParent!==null, len:t.value.length, ws:!!t.closest("[data-workspace-composer]"), stage:!!t.closest("[data-testid='new-session-stage']")})))`;
console.log("voor", await ev(ta), await ev(`location.pathname`));
if (process.env.VIA_SESSIE) {
  // Eerst een sessie openen en terug naar het lege scherm: dan mount de stage-composer opnieuw.
  console.log("rij", await ev(`(()=>{const r=[...document.querySelectorAll("[data-rail-sid]")].filter(e=>e.offsetParent)[0]; r&&r.click(); return !!r})()`));
  await sleep(2500);
  console.log("nieuw", await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(b=>/new session|nieuwe/i.test((b.getAttribute("aria-label")||"")+b.textContent)&&b.offsetParent); b&&b.click(); return b?(b.getAttribute("aria-label")||b.textContent).slice(0,40):null})()`));
  await sleep(2500);
  console.log("tussen", await ev(ta));
}
console.log("knoppen", await ev(`[...document.querySelectorAll('button[aria-label^="Opdracht geven"]')].filter(b=>b.offsetParent).length`));
await ev(`(()=>{ window.__fouten=[]; window.addEventListener('error',e=>window.__fouten.push(String(e.message))); const b=[...document.querySelectorAll('button[aria-label^="Opdracht geven"]')].filter(b=>b.offsetParent)[0]; b && b.click(); return !!b })()`);
await sleep(3200);
console.log("na", await ev(ta), await ev(`location.pathname`), await ev(`JSON.stringify(window.__fouten)`));
await send("Page.captureScreenshot", { format: "png" }, s).then(r => Bun.write("/home/agent/.cache/agent-tmp/opdracht-desktop.png", Buffer.from(r.result.data, "base64")));
await send("Target.closeTarget", { targetId });
process.exit(0);
