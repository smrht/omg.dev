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
import { useEffect, useState } from "react";
import { useUsageFeed, windowAppliesToModel, windowModel, type ProviderUsage, type UsageWindow } from "@/lib/usage";

export type GpuSessionSummary = {
  name: string;
  gpu: string;
  shape?: string;
};

export type GpuStatus = {
  checked_at: string | null;
  balance: number | null;
  rate_per_hr: number;
  active_count: number;
  sessions: GpuSessionSummary[];
  hours_left_current?: number | null;
  hours_left_l4?: number | null;
  hours_left_t4?: number | null;
  today_sessions?: number;
  today_duration_s?: number;
  today_estimated_units?: number;
  today_measured_units?: number | null;
};

const GPU_STAND_KEY = "agentbox:gpu-status-stand";
const GPU_REF_UNITS = 3000;

export function gpuBalancePct(balance: number | null): number | null {
  if (balance == null || !Number.isFinite(balance)) return null;
  return Math.max(0, Math.min(100, (balance / GPU_REF_UNITS) * 100));
}

function leesGpuStand(): { data: GpuStatus; at: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(GPU_STAND_KEY) || "null") as { data?: GpuStatus; at?: number } | null;
    if (raw?.data && typeof raw.at === "number" && Date.now() - raw.at < STAND_MAX_MS) {
      return { data: raw.data, at: raw.at };
    }
  } catch { /* privé */ }
  return null;
}

function normalizeGpuPayload(raw: Record<string, unknown>): GpuStatus | null {
  if (raw && typeof raw === "object" && "live" in raw && raw.live && typeof raw.live === "object") {
    const live = raw.live as Record<string, unknown>;
    const today = (raw.today as Record<string, unknown> | undefined) ?? {};
    return {
      checked_at: typeof live.checked_at === "string" ? live.checked_at : null,
      balance: typeof live.balance === "number" ? live.balance : null,
      rate_per_hr: typeof live.rate_per_hr === "number" ? live.rate_per_hr : 0,
      active_count: typeof live.active_count === "number" ? live.active_count : 0,
      sessions: Array.isArray(live.sessions) ? (live.sessions as GpuSessionSummary[]) : [],
      hours_left_current: typeof live.hours_left_current === "number" ? live.hours_left_current : null,
      hours_left_l4: typeof live.hours_left_l4 === "number" ? live.hours_left_l4 : null,
      hours_left_t4: typeof live.hours_left_t4 === "number" ? live.hours_left_t4 : null,
      today_sessions: typeof today.sessions === "number" ? today.sessions : undefined,
      today_duration_s: typeof today.duration_s === "number" ? today.duration_s : undefined,
      today_estimated_units: typeof today.estimated_units === "number" ? today.estimated_units : undefined,
      today_measured_units: typeof today.measured_units === "number" ? today.measured_units : null,
    };
  }
  if (raw && typeof raw === "object" && "balance" in raw) {
    return {
      checked_at: typeof raw.checked_at === "string" ? raw.checked_at : null,
      balance: typeof raw.balance === "number" ? raw.balance : null,
      rate_per_hr: typeof raw.rate_per_hr === "number" ? raw.rate_per_hr : 0,
      active_count: typeof raw.active_count === "number" ? raw.active_count : 0,
      sessions: Array.isArray(raw.sessions) ? (raw.sessions as GpuSessionSummary[]) : [],
      hours_left_current: typeof raw.hours_left_current === "number" ? raw.hours_left_current : null,
      hours_left_l4: typeof raw.hours_left_l4 === "number" ? raw.hours_left_l4 : null,
      hours_left_t4: typeof raw.hours_left_t4 === "number" ? raw.hours_left_t4 : null,
      today_sessions: typeof raw.today_sessions === "number" ? raw.today_sessions : undefined,
      today_duration_s: typeof raw.today_duration_s === "number" ? raw.today_duration_s : undefined,
      today_estimated_units: typeof raw.today_estimated_units === "number" ? raw.today_estimated_units : undefined,
      today_measured_units: typeof raw.today_measured_units === "number" ? raw.today_measured_units : null,
    };
  }
  return null;
}

function useGpuStatus(enabled: boolean): GpuStatus | null {
  const [gpu, setGpu] = useState<GpuStatus | null>(() => leesGpuStand()?.data ?? null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function load() {
      for (const url of ["/_ext/agentbox-runs/links/gpu-status.json", "/gpu-usage/api/usage"]) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) continue;
          const json = (await res.json()) as Record<string, unknown>;
          const parsed = normalizeGpuPayload(json);
          if (parsed && parsed.balance != null) {
            if (alive) setGpu(parsed);
            try { localStorage.setItem(GPU_STAND_KEY, JSON.stringify({ data: parsed, at: Date.now() })); } catch { /* privé */ }
            return;
          }
        } catch { /* probeer volgende bron */ }
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [enabled]);
  return gpu;
}

function GpuChipIcon({ active, className }: { active?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(active ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground", className)}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  );
}

function formatUnitsCompact(v: number): string {
  return Math.round(v).toLocaleString("nl-NL");
}

function formatUnitsDecimal(v: number): string {
  return v.toLocaleString("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

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
  // Een limiet per model ("7 day · Fable") is geen tweede weekregel.
  const model = windowModel(label);
  if (model) return `${model} week`;
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

/**
 * The window that runs out first: the one that decides whether you can work.
 * A limit for one model (Fable) only counts when that model is the one chosen;
 * with Opus selected a spent Fable allowance stops nothing.
 */
export function tightestWindow(windows: UsageWindow[] | undefined, model?: string | null): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const w of windows ?? []) {
    if (!windowAppliesToModel(w.label, model)) continue;
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
export function RailUsageMeters({ collapsed, onOpenGpu }: { collapsed?: boolean; onOpenGpu?: () => void }) {
  const [open, setOpen] = useState(false);
  const { refs, providers, loading } = useUsageFeed({ enabled: !collapsed, refreshMs: 5 * 60_000 });
  const gpu = useGpuStatus(!collapsed);
  if (collapsed) return null;
  // Claude en Codex blijven altijd staan: nog bezig = "…", geen cijfer = "—".
  // Een bron die stil wegvalt leest als "niks aan de hand".
  const byId = new Map(providers.map((p) => [p.id, p]));
  const KERN = new Set(["claude", "codex", "antigravity"]);
  const rows: ProviderUsage[] = [];
  for (const ref of refs ?? []) {
    if (ref.kind === "muse") continue;
    const raw = byId.get(ref.id);
    const p = raw ? metLaatsteStand(raw) : undefined;
    if (p && p.available && tightestWindow(p.windows) != null) rows.push(p);
    else if (KERN.has(ref.kind)) rows.push(p ?? { ...ref, available: false, note: "laden" });
  }
  const gpuPct = gpu ? gpuBalancePct(gpu.balance) : null;
  const gpuActive = (gpu?.active_count ?? 0) > 0;
  if (!rows.length && !gpu) {
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
          <span key={p.id} className={cn("block", standVan && "opacity-75")}>
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
      {gpu ? (
        <span className="block" data-agentbox-gpu-usage>
          <span
            className="flex items-center gap-2 text-xs"
            title={
              `Colab GPU: ${gpu.balance != null ? `${formatUnitsDecimal(gpu.balance)} u` : "onbekend"}` +
              (gpuActive ? ` · ${gpu.active_count} actief (${formatUnitsDecimal(gpu.rate_per_hr)} u/u)` : " · stil") +
              (gpu.hours_left_l4 != null ? ` · ~${formatUnitsCompact(gpu.hours_left_l4)} u L4 over` : "")
            }
          >
            <GpuChipIcon active={gpuActive} className="size-3.5 shrink-0" />
            <span className="w-16 shrink-0 truncate text-muted-foreground">Colab GPU</span>
            <span className="ab-meter block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.09]">
              <span
                className={cn(
                  "ab-meter-fill block h-full rounded-full",
                  gpuActive ? "bg-emerald-600 dark:bg-emerald-400" : leftTone(gpuPct),
                )}
                style={{ width: `${gpuPct ?? 0}%` }}
              />
            </span>
            <span className={cn("w-[4.5rem] shrink-0 text-right tabular-nums", gpuActive ? "text-emerald-700 dark:text-emerald-400 font-medium" : leftTextTone(gpuPct))}>
              {gpu.balance == null ? "—" : formatUnitsCompact(gpu.balance)}
              <span className={cn("ml-1 text-[10px]", gpuActive ? "text-emerald-700/90 dark:text-emerald-400/90" : "text-muted-foreground")}>
                {gpuActive ? `${gpu.active_count} GPU` : "u"}
              </span>
            </span>
          </span>
        </span>
      ) : null}
    </button>
    {open ? (
      <div className="max-h-72 space-y-3 overflow-y-auto px-3 pb-3 [scrollbar-width:thin]">
        {rows.filter((p) => (p.windows ?? []).length).map((p) => (
          <div key={p.id} className={cn("space-y-2", (p as ShownUsage).standVan && "opacity-75")}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <img src={agentIconSrc(p.kind)} alt="" className="size-3" />
              {providerName(p, rows)}
              {(p as ShownUsage).standVan ? <span className="font-normal text-muted-foreground">stand van {standTijd((p as ShownUsage).standVan!)}</span> : null}
            </div>
            {(p.windows ?? []).map((x) => <UsageWindowRow key={x.label} w={x} />)}
          </div>
        ))}
        {gpu ? (
          <div className="space-y-1.5 border-t border-border/50 pt-2.5">
            <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-foreground">
              <span className="flex items-center gap-1.5">
                <GpuChipIcon active={gpuActive} className="size-3" />
                Colab GPU
              </span>
              {onOpenGpu ? (
                <button
                  type="button"
                  onClick={() => { setOpen(false); onOpenGpu(); }}
                  className="text-[11px] font-normal text-muted-foreground hover:text-foreground hover:underline"
                >
                  Overzicht ↗
                </button>
              ) : (
                <a
                  href="/gpu-usage/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-normal text-muted-foreground hover:text-foreground hover:underline"
                >
                  Overzicht ↗
                </a>
              )}
            </div>
            <div className="space-y-1 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">Saldo</span>
                <span className="tabular-nums font-medium text-foreground">
                  {gpu.balance != null ? `${formatUnitsDecimal(gpu.balance)} u` : "—"}
                  {gpu.hours_left_l4 != null ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">(~{formatUnitsCompact(gpu.hours_left_l4)} u L4)</span> : null}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">Actief</span>
                <span className={cn("tabular-nums font-medium", gpuActive ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
                  {gpuActive ? `${gpu.active_count} GPU · ${formatUnitsDecimal(gpu.rate_per_hr)} u/u` : "Stil"}
                </span>
              </div>
              {gpuActive && gpu.sessions.length ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  {gpu.sessions.map((s) => `${s.name} (${s.gpu})`).join(", ")}
                </div>
              ) : null}
              {typeof gpu.today_sessions === "number" ? (
                <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>Vandaag</span>
                  <span className="tabular-nums">
                    {gpu.today_measured_units && gpu.today_measured_units > 0
                      ? `${formatUnitsDecimal(gpu.today_measured_units)} u gemeten`
                      : `~${formatUnitsDecimal(gpu.today_estimated_units ?? 0)} u`}
                    {` · ${gpu.today_sessions} sessies`}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    ) : null}
    </div>
  );
}
