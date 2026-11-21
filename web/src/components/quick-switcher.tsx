import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, ExternalLink, ListChecks, Moon, Plus, Search, Sun } from "lucide-react";
import { setThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

export interface QuickSessionItem {
  id: string;
  title: string;
  project?: string | null;
  busy?: boolean;
}

interface QuickAction {
  id: string;
  label: string;
  hint: string;
  kind: "action" | "session";
  busy?: boolean;
  run: () => void;
}

/**
 * P3c (21-11-2026): ⌘K / Ctrl+K snelkiezer voor gesprekken en schermen.
 */
export function QuickSwitcher({
  sessions,
  onSelectSession,
  onNewSession,
  onOpenTaken,
}: {
  sessions: QuickSessionItem[];
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenTaken: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActiveIndex(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<QuickAction[]>(() => {
    const q = query.trim().toLowerCase();
    const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const baseActions: QuickAction[] = [
      { id: "act-new", label: "Nieuwe sessie starten", hint: "C", kind: "action", run: () => onNewSession() },
      { id: "act-taken", label: "Taken & Voor jou openen", hint: "Zijbalk", kind: "action", run: () => onOpenTaken() },
      { id: "act-runs", label: "Runs & planningen openen", hint: "/runs", kind: "action", run: () => { window.location.assign("/runs"); } },
      { id: "act-links", label: "Links openen", hint: "/links", kind: "action", run: () => { window.location.assign("/links"); } },
      { id: "act-kie", label: "KIE Usage dashboard", hint: "nieuw tabblad", kind: "action", run: () => { window.open("https://agentbox2.tailda028c.ts.net/kie-usage/", "_blank", "noopener"); } },
      { id: "act-theme", label: isDark ? "Schakel naar lichte modus" : "Schakel naar donkere modus", hint: "Thema", kind: "action", run: () => setThemePreference(!isDark) },
    ];
    const sessionActions: QuickAction[] = sessions.slice(0, 60).map((s) => ({
      id: `sess-${s.id}`,
      label: s.title || s.id.slice(0, 8),
      hint: [s.busy ? "Bezig" : "", s.project || ""].filter(Boolean).join(" · ") || "Gesprek",
      kind: "session",
      busy: s.busy,
      run: () => onSelectSession(s.id),
    }));
    const all = [...sessionActions, ...baseActions];
    if (!q) return [...baseActions.slice(0, 4), ...sessionActions.slice(0, 8)];
    return all.filter((it) => `${it.label} ${it.hint}`.toLowerCase().includes(q)).slice(0, 14);
  }, [query, sessions, onNewSession, onOpenTaken, onSelectSession]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  if (!open) return null;

  const runItem = (it: QuickAction | undefined) => {
    if (!it) return;
    setOpen(false);
    it.run();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Snelkiezer"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/45 px-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-card shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runItem(items[activeIndex]);
              }
            }}
            placeholder="Zoek gesprek of spring naar scherm…"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">ESC</kbd>
        </div>
        <ul role="listbox" className="max-h-80 overflow-y-auto py-1.5">
          {items.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">Geen overeenkomsten voor "{query}"</li>
          ) : items.map((it, idx) => (
            <li key={it.id} role="option" aria-selected={idx === activeIndex}>
              <button
                type="button"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => runItem(it)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors",
                  idx === activeIndex ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60",
                )}
              >
                {it.id === "act-new" ? <Plus className="size-4 shrink-0 text-primary" />
                  : it.id === "act-taken" ? <ListChecks className="size-4 shrink-0 text-primary" />
                  : it.id === "act-runs" ? <Clock className="size-4 shrink-0 text-muted-foreground" />
                  : it.id === "act-theme" ? (document.documentElement.classList.contains("dark") ? <Sun className="size-4 shrink-0 text-muted-foreground" /> : <Moon className="size-4 shrink-0 text-muted-foreground" />)
                  : it.kind === "action" ? <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  : <span className={cn("size-2 shrink-0 rounded-full", it.busy ? "bg-primary" : "bg-muted-foreground/50")} />}
                <span className="min-w-0 flex-1 truncate font-medium">{it.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{it.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
