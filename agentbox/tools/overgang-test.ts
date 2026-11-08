// iPhone-app (standalone) nabootsen: chat openen zonder history-stap, sluiten met randveeg.
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
const sa = process.env.GEEN_SA ? [] : [{ name: "display-mode", value: "standalone" }];
await send("Emulation.setEmulatedMedia", { features: [...sa, { name: "pointer", value: "coarse" }] }, s);
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");localStorage.setItem("lfg_v2_user_filter","contactexpertly@gmail.com");${process.env.GEEN_SA ? 'localStorage.removeItem("ab_test_standalone")' : 'localStorage.setItem("ab_test_standalone","1")'};1`);
await send("Page.navigate", { url }, s); await sleep(7000);

// Volgt per frame: x van het paneel, transform van #root, backdrop-opacity.
const volg = `window.__spoor=[];(function f(t0){const p=document.querySelector('[role=dialog][aria-modal=true]');const r=document.getElementById('root');const b=p&&p.previousElementSibling;window.__spoor.push([Math.round(performance.now()-t0),p?Math.round(p.getBoundingClientRect().x):null,r?Math.round(new DOMMatrix(getComputedStyle(r).transform).m41):null,b?Number(getComputedStyle(b).opacity).toFixed(2):null]);if(window.__spoor.length<45)requestAnimationFrame(()=>f(t0))})(performance.now());1`;
const toon = async (n: string) => { const sp = await ev(`JSON.stringify(window.__spoor)`); const a = JSON.parse(sp); console.log(n, a.filter((_: any, i: number) => process.env.ALLES || i % 3 === 0).map((x: any) => x.join("/")).join("  ")); let g = 0; for (let i = 1; i < a.length; i++) g = Math.max(g, a[i][0] - a[i-1][0]); console.log(n, "maxGat", g); };
const shot = (n: string) => send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, s).then(r => Bun.write(`/home/agent/.cache/agent-tmp/overgang/${n}.jpg`, Buffer.from(r.result.data, "base64")));
await ev(`${volg.replace(';1', '')};(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2]; r&&r.click(); return !!r})()`);
await sleep(1200); await toon("open");
await sleep(1500);
await ev(volg); await ev(`document.querySelector('[role=dialog] button[aria-label="Close session details"]').click()`);
await sleep(1000); await toon("knop");
console.log("root na knop", await ev(`document.getElementById('root').style.transform+'|'+getComputedStyle(document.getElementById('root')).transform+'|'+!!document.querySelector('[role=dialog][aria-modal=true]')`));
await ev(`(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2]; r&&r.click(); return !!r})()`);
await sleep(2500);
const tik = (type: string, x: number, y: number) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] }, s);
await tik("touchStart", 6, 420);
for (let x = 20; x <= 200; x += 20) { await tik("touchMove", x, 424); await sleep(16); }
await sleep(200); await shot("veeg-midden");
console.log("midden", await ev(`document.getElementById('root').style.transform+' | backdrop '+getComputedStyle(document.querySelector('[role=dialog][aria-modal=true]').previousElementSibling).opacity`));
await ev(volg);
for (let x = 220; x <= 260; x += 20) { await tik("touchMove", x, 424); await sleep(16); }
await tik("touchEnd", 260, 424);
await sleep(900); await toon("veeg");
console.log("root na veeg", await ev(`document.getElementById('root').style.transform+'|'+getComputedStyle(document.getElementById('root')).transform+'|'+!!document.querySelector('[role=dialog][aria-modal=true]')`));
await shot("na-veeg");
// Terugveren: kleine veeg loslaten
await ev(`(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2]; r&&r.click(); return !!r})()`);
await sleep(2500);
await tik("touchStart", 6, 420); for (let x = 20; x <= 80; x += 20) { await tik("touchMove", x, 424); await sleep(60); } await sleep(300); await tik("touchEnd", 80, 424);
await sleep(600);
console.log("terugveer", await ev(`JSON.stringify({open:!!document.querySelector('[role=dialog][aria-modal=true]'), paneel:document.querySelector('[role=dialog][aria-modal=true]')?.getBoundingClientRect().x, root:document.getElementById('root').style.transform})`));
await shot("terugveer");

// Tik -> eerste berichtrij in beeld (inhoud), en snel open-en-terug (mis getikt).
const opnieuw = async () => { await ev(`document.querySelector('[role=dialog] button[aria-label="Close session details"]')?.click()`); await sleep(900); };
await opnieuw();
const inhoud = [];
for (let k = 0; k < 3; k++) {
  inhoud.push(await ev(`new Promise(res=>{const t0=performance.now();const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2];r.click();(function f(){const d=document.querySelector('[role=dialog][aria-modal=true] [data-index]');if(d)return res(Math.round(performance.now()-t0));if(performance.now()-t0>4000)return res(-1);requestAnimationFrame(f)})()})`));
  await sleep(1200); await opnieuw();
}
console.log("tik->inhoud ms", JSON.stringify(inhoud));
await ev(volg.replace(';1', '') + `;(()=>{const r=[...document.querySelectorAll("[data-overview-row]")].filter(e=>e.offsetParent)[2]; r.click(); setTimeout(()=>document.querySelector('[role=dialog] button[aria-label="Close session details"]').click(),120); return 1})()`);
await sleep(1100);
{ const a = JSON.parse(await ev(`JSON.stringify(window.__spoor)`)); console.log("snel", a.map((x: any) => x.join("/")).join("  ").slice(0, 900)); let g = 0, terug = 0, piek = -1; for (let i = 1; i < a.length; i++) { g = Math.max(g, a[i][0] - a[i-1][0]); } const ix = a.filter((x: any) => x[0] > 125 && x[1] !== null).map((x: any) => x[1]); for (let i = 1; i < ix.length; i++) if (ix[i] < ix[i-1] - 1) terug++; console.log("snel maxGat", g, "terugsprongen", terug, "chat gemount", await ev(`!!document.querySelector('[data-index]')`), "root", await ev(`getComputedStyle(document.getElementById('root')).transform`)); }
await send("Target.closeTarget", { targetId });
process.exit(0);
