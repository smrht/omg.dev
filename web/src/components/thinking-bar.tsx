/**
 * Segmented thinking-level slider for the desktop model picker footer.
 * Replaces the upstream blue-purple gradient + blind dots with readable
 * labels per segment in the agentbox neutral palette, while keeping slider
 * keyboard/drag accessibility intact.
 */
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type ThinkingBarChoice = {
  id: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
};

/**
 * The whole bar owns the gesture: press, click or drag across, release to pick.
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
        "relative flex flex-1 select-none items-center gap-0.5 bg-muted p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-7 rounded-lg" : "h-10 rounded-xl",
      )}
    >
      {options.map((option, index) => {
        const isActive = index === active;
        return (
          <div
            key={option.id}
            aria-hidden
            className={cn(
              "pointer-events-none flex h-full min-w-0 flex-1 items-center justify-center rounded-[6px] px-1.5 transition-colors duration-100 motion-reduce:transition-none",
              !compact && "rounded-[9px]",
              isActive
                ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border/70"
                : "text-muted-foreground",
              option.disabled && "opacity-35",
            )}
          >
            <span className={cn("truncate", compact ? "text-[11px]" : "text-xs")}>
              {option.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
