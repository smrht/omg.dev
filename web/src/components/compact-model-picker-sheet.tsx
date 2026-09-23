/**
 * The compact model picker for the mobile inline composer. One card anchored
 * above the composer's summary button: a header that names the selected agent
 * and drops down every agent (locked ones still route to connect, Claude
 * profiles are an explicit row), the favorite models (max three, with stars
 * and a link to the full searchable list), explicit thinking segments built
 * from the actual options, the Fast/Tibo toggles, and a usage row with the
 * breakdown behind it.
 *
 * Presentational only. The composer owns the selection and passes it in, the
 * same split the previous AgentSetupSheet had. Sub-pages: models, profiles,
 * usage. The card is not a modal: it traps nothing, Escape and outside presses
 * close it, and focus returns to the trigger on close.
 */
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { pickerThinkingLabel } from "../lib/model-picker-display";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Circle, Gauge, Plus, Search, Star, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export type PickerAgentTile = {
  id: string;
  label: string;
  iconSrc: string;
  selected: boolean;
  /** Supported by the product but not connected on this box. */
  locked?: boolean;
  /** The pinned Claude profile number, drawn in the corner. */
  badge?: number;
};

export type PickerChoice = { id: string; label: string; selected: boolean };

export type PickerFavoriteModel = {
  id: string;
  label: string;
  sublabel?: string;
  selected: boolean;
};

export function CompactModelPickerSheet({
  open,
  onOpenChange,
  anchorRef,
  agentLabel,
  agentIconSrc,
  agentBadge,
  agents,
  onSelectAgent,
  onLockedAgent,
  profiles = [],
  onSelectProfile,
  favorites,
  onChooseModel,
  onToggleFavorite,
  renderModels,
  thinking,
  fast,
  tibo,
  usage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef?: RefObject<HTMLElement | null>;
  agentLabel: string;
  agentIconSrc: string;
  agentBadge?: number | null;
  agents: PickerAgentTile[];
  onSelectAgent: (id: string) => void;
  onLockedAgent?: (id: string) => void;
  /** Claude profiles. Always reachable through an explicit row in the agent list. */
  profiles?: PickerChoice[];
  onSelectProfile?: (id: string) => void;
  /** Already sliced to the visible maximum by the caller. */
  favorites: PickerFavoriteModel[];
  onChooseModel: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  /** The searchable model list. `done` returns to the root page. */
  renderModels?: (done: () => void) => ReactNode;
  thinking?: { options: PickerChoice[]; onPick: (id: string) => void } | null;
  fast?: { enabled: boolean; onToggle: () => void } | null;
  tibo?: { enabled: boolean; onToggle: () => void } | null;
  usage?: { summary: string; details?: ReactNode } | null;
}) {
  const [page, setPage] = useState<"root" | "models" | "profiles" | "usage">("root");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const agentsListId = useId();
  useEffect(() => {
    if (!open) {
      setPage("root");
      setAgentsOpen(false);
    }
  }, [open]);

  // Focus lands in the card on open and returns to the trigger on close. The
  // card is non-modal on purpose: the composer stays reachable underneath.
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, [open]);

  const [position, setPosition] = useState({ left: 16, bottom: 100, width: 358, maxHeight: 480 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const width = Math.min(414, Math.max(0, (rect?.width ?? window.innerWidth) - 32));
      const top = rect?.top ?? window.innerHeight - 100;
      setPosition({ left: (rect?.left ?? 0) + ((rect?.width ?? window.innerWidth) - width) / 2,
        bottom: Math.max(8, window.innerHeight - top + 8), width, maxHeight: Math.max(80, top - 24) });
    };
    update();
    const observer = new ResizeObserver(update);
    if (anchorRef?.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); };
  }, [open, anchorRef]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node) && !anchorRef?.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, anchorRef, onOpenChange]);

  if (!open) return null;
  const close = () => onOpenChange(false);
  const back = () => setPage("root");
  const claudeTile = agents.find((agent) => agent.id === "aisdk");
  const claudeIcon = claudeTile?.iconSrc;
  const heading =
    page === "models" ? "Alle modellen" : page === "usage" ? "Gebruik" : page === "profiles" ? "Claude-profielen" : null;

  return createPortal(
    <div className="fixed z-[180]" style={{ left: position.left, bottom: position.bottom, width: position.width }}>
        <div
          ref={cardRef}
          role="dialog"
          aria-label={`${agentLabel} model picker`}
          tabIndex={-1}
          data-testid="compact-model-picker"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
          style={{ maxHeight: position.maxHeight }}
          className="flex w-full flex-col rounded-[20px] border border-border bg-popover px-3 pb-2 pt-1 text-popover-foreground shadow-xl outline-none animate-in fade-in-0 slide-in-from-bottom-2 duration-150 motion-reduce:animate-none"
        >
          <div className="flex items-center gap-1 border-b border-border pb-1">
            {page === "root" ? (
              agents.length ? (
                <button
                  type="button"
                  onClick={() => setAgentsOpen((value) => !value)}
                  aria-expanded={agentsOpen}
                  aria-controls={agentsListId}
                  aria-label={`Agent: ${agentLabel}. Change agent`}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl py-1 pr-2 pl-1 text-left outline-none focus-visible:bg-muted"
                >
                  <span className="relative flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-muted">
                    <img src={agentIconSrc} alt="" draggable={false} className="size-5 select-none" />
                    {agentBadge != null ? (
                      <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[8px] font-bold leading-none text-background ring-1 ring-popover">
                        {agentBadge}
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{agentLabel}</span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                      agentsOpen && "rotate-180",
                    )}
                  />
                </button>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-muted">
                    <img src={agentIconSrc} alt="" draggable={false} className="size-5 select-none" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{agentLabel}</span>
                </span>
              )
            ) : (
              <>
                <button
                  type="button"
                  onClick={back}
                  aria-label="Back to picker"
                  className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:bg-muted"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{heading}</span>
              </>
            )}
            <button
              type="button"
              onClick={close}
              aria-label="Close model picker"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:bg-muted"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
            {page === "root" ? (
              <div key="root" className="animate-in fade-in-0 duration-150 motion-reduce:animate-none">
                {agentsOpen ? (
                  <div id={agentsListId} className="mb-2 max-h-[38dvh] overflow-y-auto rounded-2xl border border-border">
                    <ul aria-label="All agents" className="divide-y divide-border">
                      {agents.map((agent) => (
                        <li key={agent.id}>
                          <button
                            type="button"
                            aria-label={agent.locked ? `Connect ${agent.label}` : `${agent.label} agent`}
                            aria-pressed={agent.selected}
                            onClick={() => {
                              if (agent.locked) onLockedAgent?.(agent.id);
                              else { onSelectAgent(agent.id); setAgentsOpen(false); }
                            }}
                            className="flex min-h-12 w-full items-center gap-3 px-3 text-left outline-none focus-visible:bg-muted"
                          >
                            <img
                              src={agent.iconSrc}
                              alt=""
                              draggable={false}
                              className={cn("size-6 select-none", agent.locked && "opacity-40 grayscale")}
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.label}</span>
                            {agent.locked ? (
                              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                <Plus className="size-3.5" strokeWidth={2.5} /> Verbinden
                              </span>
                            ) : agent.badge != null ? (
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-[9px] font-bold leading-none text-background">
                                {agent.badge}
                              </span>
                            ) : null}
                            {agent.selected && !agent.locked ? (
                              <Check className="size-4 shrink-0 text-primary" />
                            ) : null}
                          </button>
                        </li>
                      ))}
                      {profiles.length && claudeTile && !claudeTile.locked ? (
                        <li>
                          <button
                            type="button"
                            aria-label="Claude profiles"
                            onClick={() => {
                              setAgentsOpen(false);
                              setPage("profiles");
                            }}
                            className="flex min-h-12 w-full items-center gap-3 px-3 text-left outline-none focus-visible:bg-muted"
                          >
                            {claudeIcon ? <img src={claudeIcon} alt="" className="size-6 select-none" /> : null}
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">Claude-profielen</span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}

                <div className="flex min-h-11 items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Favoriete modellen</span>
                  {renderModels ? (
                    <button
                      type="button"
                      onClick={() => setPage("models")}
                      aria-label="All models"
                      className="flex min-h-11 items-center gap-1 rounded-full text-xs font-medium text-primary outline-none focus-visible:underline"
                    >
                      <Search className="size-3.5" />
                      Alle modellen
                    </button>
                  ) : null}
                </div>
                {favorites.length ? (
                  <div className="divide-y divide-border/70">
                    {favorites.map((favorite) => (
                      <div key={favorite.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onChooseModel(favorite.id)}
                          title={favorite.id}
                          aria-label={`Model ${favorite.label}${favorite.sublabel ? ` (${favorite.sublabel})` : ""}.${favorite.selected ? " Selected" : " Choose this model"}`}
                          className={cn(
                            "flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-1 text-left text-sm outline-none transition-colors",
                            favorite.selected
                              ? "bg-primary/8 text-primary"
                              : "focus-visible:bg-muted",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{favorite.label}</span>
                            {favorite.sublabel ? (
                              <span className="block truncate text-xs text-muted-foreground">{favorite.sublabel}</span>
                            ) : null}
                          </span>
                          {favorite.selected ? (
                            <Check aria-hidden className="size-4 shrink-0 text-primary" />
                          ) : (
                            <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/40" />
                          )}
                        </button>
                        <button
                          type="button"
                          aria-pressed
                          aria-label={`Remove ${favorite.label} from favorites`}
                          title={`Remove ${favorite.label} from favorites`}
                          onClick={() => onToggleFavorite(favorite.id)}
                          className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:bg-muted"
                        >
                          <Star className="size-4 fill-primary text-primary" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-1 pb-2 pt-1 text-xs text-muted-foreground">
                    {renderModels
                      ? "Voeg via Alle modellen een favoriet toe."
                      : "Het standaardmodel van deze agent wordt gebruikt."}
                  </p>
                )}

                {fast || tibo ? (
                  <div className="flex items-center justify-end gap-2 border-t border-border pt-1">
                    {fast ? <><span className="text-xs">Fast</span><IconToggle label="Fast mode" enabled={fast.enabled} onToggle={fast.onToggle} icon={<Gauge className="size-4" />} /></> : null}
                    {tibo ? <><span className="text-xs">Tibo</span><IconToggle label="Tibo mode: Fast service tier and High thinking" enabled={tibo.enabled} onToggle={tibo.onToggle} icon={<Zap className="size-4" />} /></> : null}
                  </div>
                ) : null}
                {thinking?.options.length ? (
                  <div className={cn("flex gap-2 border-t border-border py-1", thinking.options.length > 4 ? "flex-col" : "items-center")}>
                    <span className="shrink-0 text-[13px] font-medium">Denkwerk</span>
                    <div role="radiogroup" aria-label="Thinking level"
                      onKeyDown={(event) => {
                        if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                        event.preventDefault();
                        const options = thinking.options;
                        const current = Math.max(0, options.findIndex(option => option.selected));
                        const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
                        const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + direction + options.length) % options.length;
                        thinking.onPick(options[index]!.id);
                        (event.currentTarget.querySelectorAll('[role="radio"]')[index] as HTMLElement)?.focus();
                      }}
                      className="flex min-w-0 flex-1 gap-0.5 rounded-xl bg-muted p-0.5">
                      {thinking.options.map(option => (
                        <button key={option.id} type="button" role="radio" aria-checked={option.selected}
                          tabIndex={option.selected ? 0 : -1} title={pickerThinkingLabel(option.label)}
                          onClick={() => thinking.onPick(option.id)}
                          className={cn("min-h-11 min-w-0 flex-1 rounded-[10px] px-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", option.selected ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                          {pickerThinkingLabel(option.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {usage ? (
                  <button
                    type="button"
                    onClick={() => setPage("usage")}
                    aria-label="Usage and next resets"
                    className="flex min-h-12 w-full items-center gap-3 border-t border-border px-1 text-left outline-none focus-visible:bg-muted"
                  >
                    <Gauge className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">Gebruik</span>
                      <span className="block truncate text-xs text-muted-foreground">{usage.summary}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
              </div>
            ) : page === "models" ? (
              <div key="models" className="animate-in fade-in-0 duration-150 motion-reduce:animate-none">
                {renderModels?.(back)}
              </div>
            ) : page === "usage" ? (
              <div
                key="usage"
                className="max-h-[52dvh] overflow-y-auto pt-1 animate-in fade-in-0 duration-150 motion-reduce:animate-none"
              >
                {usage?.details ?? <p className="px-1 text-xs text-muted-foreground">{usage?.summary}</p>}
              </div>
            ) : (
              <ul
                key="profiles"
                className="pt-1 animate-in fade-in-0 duration-150 motion-reduce:animate-none"
              >
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      aria-pressed={profile.selected}
                      aria-label={`Claude ${profile.label}`}
                      onClick={() => {
                        onSelectProfile?.(profile.id);
                        back();
                      }}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium outline-none transition-colors",
                        profile.selected
                          ? "bg-primary/8 text-primary"
                          : "focus-visible:bg-muted",
                      )}
                    >
                      {claudeIcon ? <img src={claudeIcon} alt="" className="size-5 select-none" /> : null}
                      <span className="min-w-0 flex-1 truncate">
                        {profile.label === "Auto" ? "Auto" : `Profiel ${profile.label}`}
                      </span>
                      {profile.selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
    </div>,
    document.body,
  );
}

/** The Fast/Tibo squares, compacted for the picker's tighter rows. */
function IconToggle({
  label,
  enabled,
  onToggle,
  icon,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-muted outline-none focus-visible:ring-1 focus-visible:ring-ring",
        enabled ? "text-foreground ring-1 ring-inset ring-foreground/25" : "text-muted-foreground",
      )}
    >
      {icon}
    </button>
  );
}
