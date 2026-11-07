import { useState, useSyncExternalStore, type ReactNode } from "react";
import { agentboxConfig } from "@/lib/agentbox-config";
import { Search, X, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { overviewState, sessionMatchesSearch } from "@/lib/session-overview";
import { groupNodesByProject, type ProjectGroup } from "@/lib/session-groups";
import type { Session } from "../App";
import { useTakenTelling } from "./taken";

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
  const view: OverviewView = rawView === "all" || rawView === "projects" || (rawView === "taken" && agentboxConfig().taken) ? rawView : "attention";
  const rawDensity = useSyncExternalStore(subscribe, () => read("density", "compact"), () => "compact");
  const density = rawDensity === "comfortable" ? "comfortable" : "compact";
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  return { view, setView: (v: OverviewView) => write("view", v), density,
    toggleDensity: () => write("density", density === "compact" ? "comfortable" : "compact"),
    query, setQuery, unreadOnly, setUnreadOnly };
}
const ALL_VIEWS = [["taken", "Taken"], ["attention", "Aandacht"], ["all", "Alles"], ["projects", "Projecten"]] as const;
// agentbox: Taken reads Sam's own mail/conversations; other boxes do not show the tab.
const VIEWS = ALL_VIEWS.filter(([key]) => key !== "taken" || agentboxConfig().taken);

export function OverviewToolbar({ prefs, count, project, onClearProject, folderMenu }: {
  prefs: ReturnType<typeof useOverviewPreferences>; count: number; project?: string; onClearProject?: () => void; folderMenu?: ReactNode;
}) {
  // agentbox: één zoekregel met twee kleine iconen (map, filter) en daaronder
  // vier tekst-tabs met een streep die naar de gekozen weergave schuift. Zoeken
  // werkt ook in Taken. Op touch houden de knoppen 44px (agentbox.css).
  const taken = prefs.view === "taken";
  const index = Math.max(0, VIEWS.findIndex(([key]) => key === prefs.view));
  const telling = useTakenTelling();
  return <section aria-label="Gesprekkenoverzicht" onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation(); }} className="overview-toolbar ab-toolbar px-2 pb-1">
    <div className="flex items-center gap-0.5">
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="ab-search-icon pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input type="search" aria-label={taken ? "Zoek in taken" : "Zoek een gesprek"} placeholder={taken ? "Zoek in taken" : `Zoek in ${count} gesprekken`} value={prefs.query} onChange={e => prefs.setQuery(e.target.value)} className="ab-search h-8 w-full rounded-md border border-transparent bg-muted/70 pl-8 pr-7 text-[13px] outline-none placeholder:text-muted-foreground focus:border-border focus:bg-background" />
        {prefs.query && <button type="button" aria-label="Zoekopdracht wissen" onClick={() => prefs.setQuery("")} className="ab-icon-btn absolute right-0 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center text-muted-foreground"><X className="size-3.5" /></button>}
      </div>
      <div className={cn("flex items-center", taken && "invisible")}>
        {folderMenu}
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" aria-label="Weergave en filter" title="Weergave en filter" className={cn("ab-icon-btn relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted data-[popup-open]:bg-muted focus-visible:outline-2 focus-visible:outline-primary", prefs.unreadOnly ? "text-primary" : "text-muted-foreground hover:text-foreground")} />}>
            <SlidersHorizontal className="size-4" />
            {prefs.unreadOnly ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" /> : null}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuCheckboxItem checked={prefs.unreadOnly} onCheckedChange={(v) => prefs.setUnreadOnly(!!v)}>Alleen ongelezen</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.density === "compact"} onCheckedChange={() => prefs.toggleDensity()}>Compacte rijen</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <div role="group" aria-label="Weergave" className="ab-tabs relative mt-1.5 grid grid-cols-4 border-b border-border">
      {VIEWS.map(([key, label]) => <button key={key} type="button" aria-pressed={prefs.view === key} onClick={() => prefs.setView(key)} className={cn("ab-tab h-8 truncate px-0 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-primary", prefs.view === key ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground")}>{label}{key === "taken" && telling.voorJou + telling.meldingen > 0 ? <span className="ml-1 text-[11px] font-medium tabular-nums text-primary" aria-label={`${telling.voorJou} voor jou, ${telling.meldingen} meldingen`}>{telling.voorJou + telling.meldingen}</span> : null}</button>)}
      <span aria-hidden="true" className="ab-tab-streep pointer-events-none absolute -bottom-px left-0 h-[2px] w-1/4 rounded-full bg-foreground" style={{ transform: `translateX(${index * 100}%)` }} />
    </div>
    {project && <button type="button" onClick={onClearProject} className="mt-1 flex min-h-8 max-w-full items-center gap-2 px-1 text-xs text-muted-foreground" aria-label="Alle projecten tonen"><span className="truncate">{project}</span><X className="size-3 shrink-0" /></button>}
  </section>;
}
