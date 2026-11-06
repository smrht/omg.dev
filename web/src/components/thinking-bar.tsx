/**
 * ThinkingBar, lifted out of upstream's agent-setup-sheet.tsx (0.6.176).
 * Agentbox replaced the setup sheet with the compact model picker, but the
 * desktop model dropdown footer (upstream c70f47ae) still wants the bar.
 */
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type ThinkingBarChoice = {
  id: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
};

/** The iOS thinking gradient, darkened for white label contrast. */
const THINKING_GRADIENT = "linear-gradient(90deg, #2169BD 0%, #595CBE 34%, #914BAD 68%, #AF49B3 100%)";

/**
 * The whole bar owns the gesture: press, drag across, release to pick. The
 * fill always spans the full bar, so its width is the only thing that moves.
 */
export function ThinkingBar({ options, onPick, compact = false }: {
  options: ThinkingBarChoice[];
  onPick: (id: string) => void;
  compact?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.selected));
  const active = dragIndex ?? selectedIndex;
  const indexAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !rect.width) return selectedIndex;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(options.length - 1, Math.floor(ratio * options.length)));
  };
  const preview = (clientX: number) => {
    const index = indexAt(clientX);
    if (!options[index]?.disabled) setDragIndex(index);
  };
  const step = (delta: number) => {
    const option = options[selectedIndex + delta];
    if (option && !option.disabled) onPick(option.id);
  };
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Thinking level"
      aria-valuemin={0}
      aria-valuemax={options.length - 1}
      aria-valuenow={active}
      aria-valuetext={options[active]?.label}
      data-vaul-no-drag
      style={{ touchAction: "none" }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowUp") {
          event.preventDefault();
          step(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
          event.preventDefault();
          step(-1);
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        preview(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragIndex !== null) preview(event.clientX);
      }}
      onPointerUp={(event) => {
        const index = indexAt(event.clientX);
        const option = options[index];
        setDragIndex(null);
        if (option && !option.disabled && index !== selectedIndex) onPick(option.id);
      }}
      onPointerCancel={() => setDragIndex(null)}
      className={cn(
        "relative flex select-none overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-7 rounded-lg" : "h-[52px] rounded-[14px]",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-150 ease-out motion-reduce:transition-none",
          compact ? "rounded-lg" : "rounded-[14px]",
        )}
        style={{ width: `${((active + 1) / options.length) * 100}%` }}
      >
        <div className="h-full" style={{ width: `${(options.length / (active + 1)) * 100}%`, background: THINKING_GRADIENT }} />
      </div>
      {options.map((option, index) => (
        <div
          key={option.id}
          aria-hidden
          className={cn(
            "pointer-events-none relative flex flex-1 items-center justify-center",
            option.disabled && "opacity-35",
          )}
        >
          {index === active ? (
            <span className={cn("truncate px-1 font-semibold text-white", compact ? "text-[11px]" : "text-[13px]")}>{option.label}</span>
          ) : (
            <span className={cn("size-1 rounded-full", index < active ? "bg-white" : "bg-muted-foreground")} />
          )}
        </div>
      ))}
    </div>
  );
}
