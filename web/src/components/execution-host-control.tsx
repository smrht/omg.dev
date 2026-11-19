/**
 * The explicit "Uitvoeren op" choice, shared by the desktop agent/model
 * popover and the mobile compact model picker sheet. Two hosts, no "Auto":
 * the session runs where this control says it runs, and a host that cannot
 * start is shown disabled with its reason instead of being hidden or
 * substituted. The reason wraps in full — a mobile reader gets the whole
 * concrete status, never a cut-off line — and an explicit refresh control
 * re-reads that status on demand, so a Mac that came back does not need a
 * page reload to become selectable.
 */
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export type ExecutionHostOption = {
  id: string;
  label: string;
  selected: boolean;
  /** Cannot start on this box right now; `note` says why. */
  disabled?: boolean;
  note?: string;
};

export function ExecutionHostChoice({
  label = "Uitvoeren op",
  options,
  onPick,
  onRefresh,
  compact = false,
  className,
}: {
  label?: string;
  options: ExecutionHostOption[];
  onPick: (id: string) => void;
  /** Re-reads the host status for the current agent. Absent on surfaces
   * that have no live composer behind them (fork/continue). */
  onRefresh?: () => void;
  /** Tighter desktop footer layout; mobile keeps 44px touch targets. */
  compact?: boolean;
  className?: string;
}) {
  const blockedNotes = options.filter((option) => option.disabled && option.note);
  return (
    <div className={cn("min-w-0", className)} data-testid="execution-host-choice">
      <div className={cn("flex items-center gap-2", compact ? "min-h-7" : "min-h-11")}>
        <span
          className={cn(
            "shrink-0 font-medium",
            compact ? "w-20 text-xs text-muted-foreground" : "text-[13px]",
          )}
        >
          {label}
        </span>
        <div
          role="radiogroup"
          aria-label="Uitvoeren op"
          className={cn(
            "flex min-w-0 flex-1 gap-0.5 bg-muted p-0.5",
            compact ? "rounded-lg" : "rounded-xl",
          )}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.selected}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              title={option.disabled && option.note ? `${option.label}: ${option.note}` : option.label}
              data-testid={`execution-host-${option.id}`}
              onClick={() => {
                if (option.disabled) return;
                onPick(option.id);
              }}
              className={cn(
                "min-w-0 flex-1 px-2 font-medium outline-none transition-colors duration-100 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                compact
                  ? "h-6 rounded-[6px] text-[11px]"
                  : "min-h-10 rounded-[10px] text-xs",
                option.selected
                  ? compact
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border/70"
                    : "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
                option.disabled && !option.selected && "opacity-50 hover:text-muted-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Uitvoerstatus verversen"
            title="Uitvoerstatus verversen"
            data-testid="execution-host-refresh"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="size-3.5" />
          </button>
        ) : null}
      </div>
      {blockedNotes.length ? (
        <p
          className={cn(
            "leading-snug text-muted-foreground",
            compact ? "mt-1 text-[11px]" : "pb-1 text-xs",
          )}
        >
          {blockedNotes.map((option) => (
            <span key={option.id} className="block break-words">
              {option.label}: {option.note}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
