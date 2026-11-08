// Gewone tab + nieuwe sw.js: toast zolang zichtbaar, stil herladen zodra verborgen (zonder tekst).
// Gebruik: agentbox-test-browser --run-test bun stil-herladen-test.ts <url> <rebuild-cmd...>
const cdp = process.env.AGENTBOX_TEST_CDP!;
const [url, ...rebuild] = process.argv.slice(2);
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
await send("Page.navigate", { url }, s); await sleep(2500);
await ev(`localStorage.setItem("lfg_user","contactexpertly@gmail.com");1`);
await send("Page.navigate", { url }, s); await sleep(5000);
console.log("controller", await ev(`!!navigator.serviceWorker.controller`));
const ronde = async (metTekst: boolean) => {
  await ev(`window.__merk=1;1`);
  if (!metTekst) console.log("tekst leeg", await ev(`(()=>{for(const t of document.querySelectorAll('textarea')){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'');t.dispatchEvent(new Event('input',{bubbles:true}))}return [...document.querySelectorAll('textarea')].every(t=>!t.value)})()`));
  if (metTekst) console.log("tekst gezet", await ev(`(()=>{const t=[...document.querySelectorAll('textarea')].find(t=>t.offsetParent);if(!t)return false;const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'half getypt');t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`));
  const p = Bun.spawnSync(rebuild, { stdout: "ignore", stderr: "ignore" }); console.log("rebuild exit", p.exitCode);
  await ev(`navigator.serviceWorker.getRegistration().then(r=>r&&r.update()).then(()=>1)`);
  await sleep(4000);
  console.log("zichtbaar: toast", await ev(`/new version of omg/i.test(document.body.innerText)`), "zelfde pagina", await ev(`window.__merk===1`));
  const { result: { targetId: t2 } } = await send("Target.createTarget", { url: "about:blank" });
  await send("Target.activateTarget", { targetId: t2 }); await sleep(4000);
  console.log("verborgen: hidden-was", await ev(`document.visibilityState`), "zelfde pagina", await ev(`window.__merk===1`));
  await send("Target.activateTarget", { targetId }); await send("Target.closeTarget", { targetId: t2 }); await sleep(3000);
};
await ronde(true);
await ronde(false);
await send("Target.closeTarget", { targetId });
process.exit(0);
