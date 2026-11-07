/**
 * agentbox: limieten als "hoeveel heb ik nog over", per agent.
 *
 * The API reports `pct` as percent USED (see mergeProviderUsage in lib/usage).
 * Everything here shows what is LEFT: 100 - pct. A window that reported no
 * number (`pct: null`) shows a dash, never "100% over"; reading a missing
 * number as free headroom is the dangerous direction to be wrong in.
 */
import { cn } from "@/lib/utils";
import { agentIconSrc } from "@/lib/session-ui";
import { useState } from "react";
import { useUsageFeed, type ProviderUsage, type UsageWindow } from "@/lib/usage";

/**
 * Laatste goede stand per bron. Anthropic's usage-endpoint geeft geregeld 429;
 * dan is een cijfer van een kwartier oud (gedempt, met tijd) beter dan niets.
 * Een bron die nooit een cijfer gaf blijft "—".
 */
type Stand = { windows: UsageWindow[]; at: number };
const STAND_KEY = "agentbox:usage-stand";
const STAND_MAX_MS = 12 * 60 * 60_000;
function leesStanden(): Record<string, Stand> {
  try { return JSON.parse(localStorage.getItem(STAND_KEY) || "{}") as Record<string, Stand>; } catch { return {}; }
}
export type ShownUsage = ProviderUsage & { standVan?: number };
export function metLaatsteStand(p: ProviderUsage): ShownUsage {
  const standen = leesStanden();
  const heeftCijfer = p.available && (p.windows ?? []).some((w) => w.pct != null);
  if (heeftCijfer) {
    standen[p.id] = { windows: p.windows!, at: Date.now() };
    try { localStorage.setItem(STAND_KEY, JSON.stringify(standen)); } catch { /* vol of privé */ }
    return p;
  }
  const oud = standen[p.id];
  if (oud && Date.now() - oud.at < STAND_MAX_MS) {
    return { ...p, available: true, windows: oud.windows, standVan: oud.at, note: p.note };
  }
  return p;
}
export function standTijd(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function leftPct(w: UsageWindow): number | null {
  if (w.pct == null || !Number.isFinite(w.pct)) return null;
  return Math.max(0, Math.min(100, 100 - w.pct));
}

export function windowName(label: string): string {
  const l = label.toLowerCase();
  if (/^5\s*h|5 hr|5-hour|session/.test(l)) return "5 uur";
  if (/7\s*d|week/.test(l)) return "week";
  if (/opus/.test(l)) return "Opus week";
  if (/sonnet/.test(l)) return "Sonnet week";
  if (/month|maand/.test(l)) return "maand";
  if (/day|dag/.test(l)) return "dag";
  return label;
}

const DAGEN = ["zo", "ma", "di", "wo", "do", "vr", "za"];

export function resetText(ms: number | null): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "reset nu";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `reset over ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `reset over ${hrs} u`;
  const d = new Date(ms);
  return `reset ${DAGEN[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The window that runs out first: the one that decides whether you can work. */
export function tightestWindow(windows: UsageWindow[] | undefined): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const w of windows ?? []) {
    const left = leftPct(w);
    if (left == null) continue;
    if (!best || left < (leftPct(best) ?? 101)) best = w;
  }
  return best;
}

export function leftTone(left: number | null): string {
  if (left == null) return "bg-muted-foreground/30";
  if (left <= 10) return "bg-destructive";
  if (left <= 25) return "bg-primary";
  return "bg-foreground/55";
}

function leftTextTone(left: number | null): string {
  if (left == null) return "text-muted-foreground";
  if (left <= 10) return "text-destructive";
  if (left <= 25) return "text-primary";
  return "text-foreground";
}

export function providerName(p: ProviderUsage, all: ProviderUsage[]): string {
  const sameKind = all.filter((x) => x.kind === p.kind).length;
  if (sameKind > 1 && p.accountLabel) return p.accountLabel;
  return p.label;
}

/** Only sources that actually report a limit; Cursor/Grok/omg without login and OpenCode's token stats drop out. */
export function meterProviders(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((p) => p.available && (p.windows ?? []).length > 0);
}

export function MeterBar({ left, className }: { left: number | null; className?: string }) {
  return (
    <span className={cn("ab-meter block h-1.5 overflow-hidden rounded-full bg-foreground/[0.09]", className)}>
      <span
        className={cn("ab-meter-fill block h-full rounded-full", leftTone(left))}
        style={{ width: `${left ?? 0}%` }}
      />
    </span>
  );
}

/** One limit window: name, bar, "20% over", reset. Used in the popover and the mobile sheet. */
export function UsageWindowRow({ w }: { w: UsageWindow }) {
  const left = leftPct(w);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{windowName(w.label)}</span>
        <span className={cn("tabular-nums font-medium", leftTextTone(left))}>
          {left == null ? "geen cijfer" : `${Math.round(left)}% over`}
        </span>
      </div>
      <MeterBar left={left} />
      {w.resetsAt ? <div className="text-[11px] text-muted-foreground/80">{resetText(w.resetsAt)}</div> : null}
    </div>
  );
}

/**
 * Rail footer: every agent with a limit on one line. The number is what is left
 * of the window that runs out first; the full breakdown opens on click.
 */
export function RailUsageMeters({ collapsed }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const { refs, providers, loading } = useUsageFeed({ enabled: !collapsed, refreshMs: 5 * 60_000 });
  if (collapsed) return null;
  // Claude en Codex blijven altijd staan: nog bezig = "…", geen cijfer = "—".
  // Een bron die stil wegvalt leest als "niks aan de hand".
  const byId = new Map(providers.map((p) => [p.id, p]));
  const KERN = new Set(["claude", "codex"]);
  const rows: ProviderUsage[] = [];
  for (const ref of refs ?? []) {
    const raw = byId.get(ref.id);
    const p = raw ? metLaatsteStand(raw) : undefined;
    if (p && p.available && (p.windows ?? []).length) rows.push(p);
    else if (KERN.has(ref.kind)) rows.push(p ?? { ...ref, available: false, note: "laden" });
  }
  if (!rows.length) {
    return loading ? (
      <div className="ab-usage-voet px-3 py-2 text-[11px] text-muted-foreground">Limieten laden…</div>
    ) : null;
  }
  return (
    <div className="ab-usage-voet shrink-0 border-t border-border/60">
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      title={open ? "Inklappen" : "Per venster bekijken"}
      data-agentbox-usage
      className="block w-full space-y-1.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary"
    >
      {rows.map((p) => {
        const w = tightestWindow(p.windows);
        const left = w ? leftPct(w) : null;
        const bezig = !byId.has(p.id);
        const standVan = (p as ShownUsage).standVan;
        return (
          <span key={p.id} className={cn("block", standVan && "opacity-60")}>
          <span className="flex items-center gap-2 text-xs" title={standVan ? `Stand van ${standTijd(standVan)}; ${p.note ?? "de bron geeft nu geen cijfer"}` : !p.windows?.length ? (p.note ?? "geen limietcijfers") : (p.windows ?? []).map((x) => `${windowName(x.label)}: ${leftPct(x) == null ? "geen cijfer" : `${Math.round(leftPct(x)!)}% over`}${x.resetsAt ? `, ${resetText(x.resetsAt)}` : ""}`).join("\n")}>
            <img src={agentIconSrc(p.kind)} alt="" className="size-3.5 shrink-0" />
            <span className="w-16 shrink-0 truncate text-muted-foreground">{providerName(p, rows)}</span>
            <MeterBar left={left} className="min-w-0 flex-1" />
            <span className={cn("w-[4.5rem] shrink-0 text-right tabular-nums", leftTextTone(left))}>
              {bezig ? "…" : left == null ? "—" : `${Math.round(left)}%`}
              {standVan ? <span className="sr-only"> (stand van {standTijd(standVan)})</span> : null}
              {w ? <span className="ml-1 text-[10px] text-muted-foreground">{standVan ? standTijd(standVan) : windowName(w.label)}</span> : null}
            </span>
          </span>
          </span>
        );
      })}
    </button>
    {open ? (
      <div className="max-h-60 space-y-3 overflow-y-auto px-3 pb-3 [scrollbar-width:thin]">
        {rows.filter((p) => (p.windows ?? []).length).map((p) => (
          <div key={p.id} className={cn("space-y-2", (p as ShownUsage).standVan && "opacity-60")}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <img src={agentIconSrc(p.kind)} alt="" className="size-3" />
              {providerName(p, rows)}
              {(p as ShownUsage).standVan ? <span className="font-normal text-muted-foreground">stand van {standTijd((p as ShownUsage).standVan!)}</span> : null}
            </div>
            {(p.windows ?? []).map((x) => <UsageWindowRow key={x.label} w={x} />)}
          </div>
        ))}
      </div>
    ) : null}
    </div>
  );
}
