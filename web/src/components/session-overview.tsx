import { useState, useSyncExternalStore } from "react";
import { Search, X, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { overviewState, sessionMatchesSearch } from "@/lib/session-overview";
import { groupNodesByProject, type ProjectGroup } from "@/lib/session-groups";
import type { Session } from "../App";

export type OverviewNode = { session: Session; children: OverviewNode[] };
export type OverviewView = "taken" | "attention" | "all" | "projects";
const EVENT = "omg-overview-preferences";
const KEY = "omg:overview:";
const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb); window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", cb); };
};
function read(key: string, fallback: string) {
  try { return window.localStorage.getItem(KEY + key) || fallback; } catch { return fallback; }
}
function write(key: string, value: string) {
  try { window.localStorage.setItem(KEY + key, value); } catch { /* unavailable storage keeps defaults */ }
  window.dispatchEvent(new Event(EVENT));
}
export function flattenOverview(nodes: OverviewNode[]): Session[] {
  return nodes.flatMap(n => [n.session, ...flattenOverview(n.children)]);
}
/** Keep a matched child's ancestry; a matched parent keeps its whole family. */
export function filterOverview(nodes: OverviewNode[], match: (s: Session) => boolean): OverviewNode[] {
  return nodes.flatMap(n => {
    if (match(n.session)) return [n];
    const children = filterOverview(n.children, match);
    return children.length ? [{ ...n, children }] : [];
  });
}
export function buildOverviewGroups({ nodes, pins, view, query, unreadOnly, unread, busy, questions, shortProject }: {
  nodes: OverviewNode[]; pins: ReadonlySet<string>; view: OverviewView; query: string;
  unreadOnly: boolean; unread: ReadonlySet<string>; busy: Record<string, boolean>;
  questions: ReadonlySet<string>; shortProject: (p: string) => string;
}): ProjectGroup<OverviewNode>[] {
  if (view === "taken") return [];
  const filtered = filterOverview(nodes, s => sessionMatchesSearch(s, query) && (!unreadOnly || unread.has(s.sessionId || "")));
  const count = (n: OverviewNode) => flattenOverview([n]).length;
  if (view === "projects") return groupNodesByProject(filtered, count, shortProject);
  const bins = new Map<string, OverviewNode[]>();
  const labels: Record<string, string> = { attention: "Wacht op jou", pinned: "Vastgepind", working: "Bezig", recent: "Recente gesprekken" };
  for (const n of filtered) {
    const family = flattenOverview([n]);
    const states = family.map(s => overviewState(s, busy[s.sessionId || ""] ?? !!s.busy, questions));
    const state = states.includes("attention") ? "attention" : states.includes("working") ? "working" : "recent";
    const pinned = family.some(s => pins.has(s.sessionId || ""));
    const key = view === "attention" && state === "attention" ? "attention" : pinned ? "pinned" : view === "all" ? "recent" : state;
    const bin = bins.get(key) || []; bin.push(n); bins.set(key, bin);
  }
  return ["attention", "pinned", "working", "recent"].flatMap(key => {
    const group = bins.get(key); if (!group?.length) return [];
    if (key !== "pinned") group.sort((a,b) => (b.session.lastActivityAt ?? b.session.startedAt ?? 0) - (a.session.lastActivityAt ?? a.session.startedAt ?? 0));
    return [{ key: "overview:" + key, label: labels[key]!, project: "", nodes: group, count: group.reduce((sum,n) => sum+count(n), 0) }];
  });
}
export function useOverviewPreferences() {
  const rawView = useSyncExternalStore(subscribe, () => read("view", "attention"), () => "attention");
  const view: OverviewView = rawView === "all" || rawView === "projects" || rawView === "taken" ? rawView : "attention";
  const rawDensity = useSyncExternalStore(subscribe, () => read("density", "compact"), () => "compact");
  const density = rawDensity === "comfortable" ? "comfortable" : "compact";
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  return { view, setView: (v: OverviewView) => write("view", v), density,
    toggleDensity: () => write("density", density === "compact" ? "comfortable" : "compact"),
    query, setQuery, unreadOnly, setUnreadOnly };
}
export function OverviewToolbar({ prefs, count, project, onClearProject }: {
  prefs: ReturnType<typeof useOverviewPreferences>; count: number; project?: string; onClearProject?: () => void;
}) {
  // agentbox: compacte werkbalk. Geen aparte kopregel meer: het aantal staat in
  // de segmentknop staat bovenaan en verspringt niet; zoeken, Ongelezen en dichtheid zijn kleine knoppen ernaast, de vier
  // weergaven een segmentknop. Op touch houden de knoppen 44px (index-css).
  const taken = prefs.view === "taken";
  return <section aria-label="Gesprekkenoverzicht" onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation(); }} className="overview-toolbar ab-toolbar px-1.5 pb-1.5">
    <div role="group" aria-label="Groepeer gesprekken" className="ab-tabs grid grid-cols-4 gap-0.5 rounded-md bg-muted p-0.5">
      {([ ["taken", "Taken"], ["attention", "Aandacht"], ["all", "Alles"], ["projects", "Projecten"] ] as const).map(([key,label]) => <button key={key} type="button" aria-pressed={prefs.view===key} onClick={() => prefs.setView(key)} className={cn("ab-tab h-7 truncate rounded-[5px] px-0 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", prefs.view===key ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,.12)]" : "text-muted-foreground hover:text-foreground")}>{label}</button>)}
    </div>
    <div className={cn("mt-1.5 flex items-center gap-1", taken && "hidden")}>
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="ab-search-icon pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input type="search" aria-label="Zoek een gesprek" placeholder="Zoek" value={prefs.query} onChange={e => prefs.setQuery(e.target.value)} className="ab-search h-8 w-full rounded-md border border-transparent bg-muted pl-8 pr-8 text-[13px] outline-none placeholder:text-muted-foreground focus:border-primary/60" />
        {prefs.query && <button type="button" aria-label="Zoekopdracht wissen" onClick={() => prefs.setQuery("")} className="ab-icon-btn absolute right-0 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center text-muted-foreground"><X className="size-3.5" /></button>}
      </div>
      <button type="button" aria-pressed={prefs.unreadOnly} onClick={() => prefs.setUnreadOnly(!prefs.unreadOnly)} title="Alleen ongelezen" className={cn("ab-icon-btn flex h-8 shrink-0 items-center rounded-md px-2 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-primary", prefs.unreadOnly ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>Ongelezen</button>
      <button type="button" onClick={prefs.toggleDensity} aria-label={prefs.density === "compact" ? "Ruime weergave" : "Compacte weergave"} title={prefs.density === "compact" ? "Ruime weergave" : "Compacte weergave"} className={cn("ab-icon-btn flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary")}><SlidersHorizontal className="size-3.5" /></button>
    </div>
    {project && <button type="button" onClick={onClearProject} className="mt-1 flex min-h-8 max-w-full items-center gap-2 px-1 text-xs text-muted-foreground" aria-label="Alle projecten tonen"><span className="truncate">{project}</span><X className="size-3 shrink-0" /></button>}
  </section>;
}
