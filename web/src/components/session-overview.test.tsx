import { afterEach, test, expect } from "bun:test";
import { mount, type Mounted } from "../test-support/render";
const { buildOverviewGroups, flattenOverview, OverviewToolbar, useOverviewPreferences } = await import("./session-overview");
let ui: Mounted;
afterEach(() => ui?.cleanup());
const node = (id: string, fields = {}, children: any[] = []) => ({ session: { sessionId: id, title: id, ...fields }, children });
const base = { pins: new Set<string>(), view: "attention" as const, query: "", unreadOnly: false, unread: new Set<string>(), busy: {}, questions: new Set<string>(), shortProject: (s:string) => s };
test("attention outranks pin, family remains together, every session occurs once", () => {
 const result = buildOverviewGroups({...base, nodes:[node("parent",{},[node("child",{status:"blocked"})]),node("pinned"),node("working"),node("idle")],pins:new Set(["parent","pinned"]),busy:{working:true}});
 expect(result.map(g=>g.key)).toEqual(["overview:attention","overview:pinned","overview:working","overview:recent"]);
 expect(flattenOverview(result.flatMap(g=>g.nodes)).map(s=>s.sessionId)).toEqual(["parent","child","pinned","working","idle"]);
});
test("search matching child retains ancestry but excludes unrelated siblings",()=>{
 const result=buildOverviewGroups({...base,query:"needle",nodes:[node("parent",{},[node("child",{title:"needle"}),node("other")])]});
 expect(flattenOverview(result.flatMap(g=>g.nodes)).map(s=>s.sessionId)).toEqual(["parent","child"]);
});
test("project view retains pins; unread uses authoritative set",()=>{
 const result=buildOverviewGroups({...base,view:"projects",pins:new Set(["a"]),unreadOnly:true,unread:new Set(["a"]),nodes:[node("a",{project:"study"}),node("b",{project:"work",unread:true})]});
 expect(result.map(g=>g.label)).toEqual(["study"]);expect(result[0]?.count).toBe(1);
});
test("toolbar controls query, view and density; no reload required",async()=>{
 function Harness(){const prefs=useOverviewPreferences();return <><OverviewToolbar prefs={prefs} count={3}/><output>{prefs.view}:{prefs.density}:{prefs.unreadOnly.toString()}</output></>}
 ui=mount();ui.render(<Harness/>);
 const projects=ui.queryAll('button[aria-pressed]').find(e=>e.textContent==='Projecten') as HTMLButtonElement;
 ui.flush(()=>projects.click());expect(ui.query('output')?.textContent).toContain('projects');
 // agentbox: dichtheid en ongelezen zitten in het menu "Weergave en filter".
 const item=async(label:string)=>{if(!document.querySelector('[role="menu"]'))await ui.flushAsync(()=>(ui.query('[aria-label="Weergave en filter"]') as HTMLElement).click());await ui.flushAsync(()=>(Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(e=>e.textContent?.includes(label)) as HTMLElement).click());};
 await item('Compacte rijen');expect(ui.query('output')?.textContent).toContain('comfortable');
 await item('Alleen ongelezen');expect(ui.query('output')?.textContent).toContain('true');
});
