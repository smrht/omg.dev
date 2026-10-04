import { useState, useSyncExternalStore } from "react";
import { Search, X, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { overviewState, sessionMatchesSearch } from "@/lib/session-overview";
import { groupNodesByProject, type ProjectGroup } from "@/lib/session-groups";
import type { Session } from "../App";

export type OverviewNode = { session: Session; children: OverviewNode[] };
export type OverviewView = "attention" | "all" | "projects";
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
  const view: OverviewView = rawView === "all" || rawView === "projects" ? rawView : "attention";
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
  return <section aria-label="Gesprekkenoverzicht" onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation(); }} className="overview-toolbar px-2 pb-2">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold tracking-tight">Gesprekken <span className="ml-1 text-xs font-normal text-muted-foreground">{count}</span></h2>
      <div className="flex items-center gap-1">
        <label className="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={prefs.unreadOnly} onChange={e => prefs.setUnreadOnly(e.target.checked)} className="size-3.5 accent-primary" />Ongelezen</label>
      <button type="button" onClick={prefs.toggleDensity} aria-label={prefs.density === "compact" ? "Ruime weergave" : "Compacte weergave"} title={prefs.density === "compact" ? "Ruime weergave" : "Compacte weergave"} className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><SlidersHorizontal className="size-4" /><span className="sr-only">{prefs.density === "compact" ? "Compact" : "Ruim"}</span></button>
      </div>
    </div>
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
      <input type="search" aria-label="Zoek een gesprek" placeholder="Zoek een gesprek…" value={prefs.query} onChange={e => prefs.setQuery(e.target.value)} className="h-11 w-full rounded-lg border border-border/60 bg-muted/40 pl-9 pr-10 text-base outline-none placeholder:text-muted-foreground focus:border-primary" />
      {prefs.query && <button type="button" aria-label="Zoekopdracht wissen" onClick={() => prefs.setQuery("")} className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted-foreground"><X className="size-4" /></button>}
    </div>
    <div role="group" aria-label="Groepeer gesprekken" className="mt-1 flex border-b border-border/60">
      {([ ["attention", "Aandacht"], ["all", "Alle chats"], ["projects", "Projecten"] ] as const).map(([key,label]) => <button key={key} type="button" aria-pressed={prefs.view===key} onClick={() => prefs.setView(key)} className={cn("min-h-11 flex-1 border-b-2 px-1 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-primary", prefs.view===key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>)}
    </div>
    {project && <button type="button" onClick={onClearProject} className="mt-1 flex min-h-11 max-w-full items-center gap-2 text-xs text-muted-foreground" aria-label="Alle projecten tonen"><span className="truncate">{project}</span><X className="size-3 shrink-0" /></button>}

  </section>;
}
