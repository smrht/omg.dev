// Firefox (WebDriver BiDi) versie van opdracht-test.ts: echte muisklik op "Opdracht geven".
// Gebruik: FFBIDI=ws://127.0.0.1:9333/session bun opdracht-firefox.ts <url>
const [url] = process.argv.slice(2);
const ws = new WebSocket(process.env.FFBIDI ?? "ws://127.0.0.1:9333/session");
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0; const wait = new Map<number, (v: any) => void>(); const logs: string[] = [];
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.id && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); } else if (m.method === "log.entryAdded") logs.push(`${m.params.level} ${String(m.params.text).slice(0, 300)}`); });
const send = (method: string, params: any = {}) => new Promise<any>(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
console.log("sessie", (await send("session.new", { capabilities: {} })).result?.capabilities?.browserVersion);
await send("session.subscribe", { events: ["log.entryAdded"] });
const ctx = (await send("browsingContext.getTree", {})).result.contexts[0].context;
await send("browsingContext.setViewport", { context: ctx, viewport: { width: Number(process.env.BREED ?? 960), height: 900 } });
const ev = async (expr: string) => { const r = await send("script.evaluate", { expression: expr, target: { context: ctx }, awaitPromise: true, resultOwnership: "none" }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? JSON.stringify(r.error ?? r.result); };
await send("browsingContext.navigate", { context: ctx, url, wait: "complete" }); await sleep(2000);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");1`);
await send("browsingContext.navigate", { context: ctx, url, wait: "complete" }); await sleep(8000);
const ta = `JSON.stringify([...document.querySelectorAll("textarea")].map(t=>({ph:t.placeholder.slice(0,30), zichtbaar:t.getClientRects().length>0, len:t.value.length})))`;
console.log("voor", await ev(ta), await ev(`location.pathname`));
if (process.env.RAILTAKEN) {
  console.log("railtab", await ev(`(()=>{const b=[...document.querySelectorAll("button,[role=tab]")].find(b=>/^Taken/.test(b.textContent.trim())&&b.offsetParent); b&&b.click(); return b?b.textContent.trim():null})()`));
  await sleep(2000);
}
await ev(`(()=>{ window.__fouten=[]; window.__ev=0; window.addEventListener('agentbox-opdracht',()=>window.__ev++); window.addEventListener('click',e=>{window.__klik=(e.target.closest?.('button')||{outerHTML:'(geen knop) '+e.target.nodeName}).outerHTML?.slice(0,160)},true); window.addEventListener('error',e=>window.__fouten.push(String(e.message))); window.addEventListener('unhandledrejection',e=>window.__fouten.push('rej '+String(e.reason))); return 1})()`);
await ev(`(()=>{const b=[...document.querySelectorAll('button[aria-label^="Opdracht geven"]')].filter(b=>b.getClientRects().length)[${Number(process.env.KNOP ?? 0)}]; b&&b.scrollIntoView({block:'center'}); return 1})()`); await sleep(600);
console.log("venster", await ev(`innerWidth+'x'+innerHeight`));
const pos = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('button[aria-label^="Opdracht geven"]')].filter(b=>b.getClientRects().length).map(b=>{const r=b.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const top=document.elementFromPoint(x,y); return {x:Math.round(x),y:Math.round(y),l:b.getAttribute('aria-label').slice(0,50), boven: top===b||b.contains(top) ? 'ok' : (top?top.nodeName+'.'+String(top.className).slice(0,60):'niets')}}))`));
console.log("knoppen", JSON.stringify(pos));
const k = pos[Number(process.env.KNOP ?? 0)];
if (k) await send("input.performActions", { context: ctx, actions: [{ type: "pointer", id: "muis", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: k.x, y: k.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
await sleep(3200);
console.log("na", await ev(`JSON.stringify({ev:window.__ev, klik:window.__klik, fouten:window.__fouten})`), await ev(ta), await ev(`location.pathname`));
const shot = await send("browsingContext.captureScreenshot", { context: ctx });
if (shot.result?.data) await Bun.write("/home/agent/.cache/agent-tmp/opdracht-firefox.png", Buffer.from(shot.result.data, "base64"));
console.log("logs", logs.slice(-15).join("\n"));
await send("session.end", {});
process.exit(0);
